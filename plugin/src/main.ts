import {
	Keymap,
	MarkdownPostProcessorContext,
	Platform,
	Plugin,
	TFile,
	debounce,
} from "obsidian";

import {
	buildDocumentTree,
	treeIdOf,
	type DocumentTree,
	type ForesterNode,
} from "./forest";
import { buildHeader, buildSlug, buildTaxonSpan, buildMetadata } from "./render";
import { DEFAULT_SETTINGS, ForesterSettingTab, type ForesterSettings } from "./settings";

/** Marks elements we have already rewritten so passes stay idempotent. */
const DONE = "data-forester";

export default class ForesterPlugin extends Plugin {
	settings: ForesterSettings = { ...DEFAULT_SETTINGS };

	private trees = new Map<string, DocumentTree>();
	private observer: MutationObserver | null = null;
	/** Set when a tree changed underneath us, forcing a full re-number. */
	private dirty = true;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applySettingsToDom();

		// Reading view: headings, the root title, and depth indentation.
		this.registerMarkdownPostProcessor((el, ctx) => this.processReadingSection(el, ctx));

		// Embeds are decorated from a single observer so that reading view,
		// Live Preview, hover popovers and Canvas all go through one path.
		// Phones have far less headroom for DOM work, so wait longer there.
		const rescan = debounce(() => this.decorateEmbeds(), Platform.isMobile ? 150 : 40, true);
		const invalidate = () => {
			this.dirty = true;
			rescan();
		};

		this.observer = new MutationObserver((mutations) => {
			// The editor mutates the DOM on every keystroke; most of that has
			// nothing to do with embeds and must not cost a document-wide scan.
			if (this.dirty || touchesEmbed(mutations)) rescan();
		});
		this.observer.observe(document.body, { childList: true, subtree: true });
		this.register(() => this.observer?.disconnect());

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.trees.delete(file.path);
				invalidate();
			}),
		);
		this.registerEvent(this.app.workspace.on("layout-change", invalidate));

		this.addSettingTab(new ForesterSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(rescan);
	}

	onunload(): void {
		this.observer?.disconnect();
		document.body.removeClass("forester-enabled", "forester-mobile");
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.applySettingsToDom();
	}

	applySettingsToDom(): void {
		document.body.addClass("forester-enabled");
		document.body.toggleClass("forester-mobile", Platform.isMobile);
		document.body.toggleClass("forester-hide-slugs", !this.settings.showSlugs);
		document.body.toggleClass("forester-no-numbers", !this.settings.numberSubtrees);
		document.body.style.setProperty(
			"--forester-indent",
			`${this.settings.indentPerLevel}px`,
		);
	}

	// ── tree model ────────────────────────────────────────────────────────────

	private treeFor(file: TFile, text?: string): DocumentTree | null {
		// Directives live in HTML comments, which the metadata cache drops, so a
		// tree built with the raw text supersedes one built without it.
		const cached = this.trees.get(file.path);
		if (cached && !text) return cached;

		const tree = buildDocumentTree(this.app, file, text);
		if (tree) this.trees.set(file.path, tree);
		return tree;
	}

	private fileFor(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	// ── reading view ──────────────────────────────────────────────────────────

	private processReadingSection(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		const file = this.fileFor(ctx.sourcePath);
		if (!file) return;

		const info = ctx.getSectionInfo(el);
		const tree = this.treeFor(file, info?.text);
		if (!tree) return;

		const headings = Array.from(
			el.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6"),
		).filter((h) => !h.closest(".internal-embed"));

		for (const heading of headings) {
			const level = Number(heading.tagName.substring(1));
			const node = this.nodeForHeading(tree, heading, level, info?.lineStart);
			this.decorateHeading(heading, tree, node, level, file);
		}

		// Indent ordinary blocks to the depth of the subtree they belong to.
		if (headings.length === 0 && info) {
			const depth = depthAtLine(tree, info.lineStart);
			if (depth > 0) setDepth(el, depth);
		}
	}

	private nodeForHeading(
		tree: DocumentTree,
		heading: HTMLElement,
		level: number,
		lineStart?: number,
	): ForesterNode | null {
		if (lineStart !== undefined) {
			const byLine = tree.byLine.get(lineStart);
			if (byLine) return byLine;
		}
		// Popovers and exported views do not always expose section info.
		const text = heading.textContent?.trim() ?? "";
		let match: ForesterNode | null = null;
		visit(tree.root, (node) => {
			if (!match && node.kind === "heading" && node.level === level && node.title === text) {
				match = node;
			}
		});
		return match;
	}

	private decorateHeading(
		heading: HTMLElement,
		tree: DocumentTree,
		node: ForesterNode | null,
		level: number,
		file: TFile,
	): void {
		if (heading.hasAttribute(DONE)) return;
		heading.setAttribute(DONE, "heading");

		const isRoot = level === 1 && node === null;
		const doc = heading.ownerDocument;

		if (isRoot) {
			// The document's own `# Title` is the root tree's `\title`.
			const root = tree.root;
			heading.addClass("forester-root-title");
			if (root.meta.taxon) heading.setAttribute("data-taxon", root.meta.taxon);

			const taxon = buildTaxonSpan(doc, {
				numberPath: "",
				meta: root.meta,
				taxon: root.meta.taxon,
				isRoot: true,
			});
			if (taxon) heading.prepend(taxon);

			const slug = buildSlug(doc, root.uri);
			if (slug) {
				heading.appendChild(doc.createTextNode(" "));
				heading.appendChild(slug);
				this.wireSlug(slug, file.path, file.path);
			}

			const metadata = buildMetadata(doc, root.meta);
			if (metadata) heading.insertAdjacentElement("afterend", metadata);
			return;
		}

		if (!node) return;

		setDepth(heading, depthOf(node));
		heading.addClass("forester-subtree-title");

		const numberPath = joinNumber(ancestorNumber(heading), node.localPath);
		const taxon = buildTaxonSpan(doc, {
			numberPath: node.shouldNumber && this.settings.numberSubtrees ? numberPath : "",
			meta: node.meta,
			taxon: node.meta.taxon,
			isRoot: false,
		});
		if (taxon) heading.prepend(taxon);

		const slug = buildSlug(doc, node.uri);
		if (slug) {
			heading.appendChild(doc.createTextNode(" "));
			heading.appendChild(slug);
			// A named subtree lives inside this note, so the slug is an anchor.
			this.wireSlug(slug, `${file.path}#${node.title}`, file.path);
		}

		heading.setAttribute("data-forester-number", numberPath);
	}

	// ── transclusions ─────────────────────────────────────────────────────────

	private decorateEmbeds(): void {
		if (!this.settings.transclusionHeaders) return;

		const embeds = Array.from(
			document.querySelectorAll<HTMLElement>(".internal-embed.markdown-embed.is-loaded"),
		);

		// Nothing new and nothing invalidated: skip the whole grouping pass.
		if (!this.dirty && embeds.every((embed) => embed.hasAttribute(DONE))) return;
		this.dirty = false;

		// Group by host document so sibling positions can be zipped against the
		// host tree's embed nodes in source order.
		const groups = new Map<HTMLElement | null, HTMLElement[]>();
		for (const embed of embeds) {
			const host = embed.parentElement?.closest<HTMLElement>(".internal-embed") ?? null;
			const list = groups.get(host);
			if (list) list.push(embed);
			else groups.set(host, [embed]);
		}

		for (const [host, list] of groups) {
			const hostFile = host ? this.embedTarget(host) : null;
			// Embeds directly in a note are grouped per rendered container, since
			// several notes can be open at once.
			if (host) {
				if (hostFile) this.decorateGroup(hostFile, list);
				continue;
			}
			const byContainer = new Map<HTMLElement, HTMLElement[]>();
			for (const embed of list) {
				const container = embed.closest<HTMLElement>(
					".markdown-preview-view, .markdown-source-view, .markdown-rendered",
				);
				if (!container) continue;
				const bucket = byContainer.get(container);
				if (bucket) bucket.push(embed);
				else byContainer.set(container, [embed]);
			}
			for (const [container, bucket] of byContainer) {
				const file = this.containerFile(container);
				if (file) this.decorateGroup(file, bucket);
			}
		}
	}

	/** Resolve the note a rendered container belongs to. */
	private containerFile(container: HTMLElement): TFile | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as { containerEl?: HTMLElement; file?: TFile | null };
			if (view.containerEl?.contains(container) && view.file) return view.file;
		}
		const active = this.app.workspace.getActiveFile();
		return active ?? null;
	}

	private embedTarget(embed: HTMLElement, hostPath = ""): TFile | null {
		const src = embed.getAttribute("src");
		if (!src) return null;
		return this.app.metadataCache.getFirstLinkpathDest(src.split("#")[0], hostPath);
	}

	private decorateGroup(hostFile: TFile, embeds: HTMLElement[]): void {
		const tree = this.treeFor(hostFile);
		if (!tree) return;

		const nodes: ForesterNode[] = [];
		visit(tree.root, (node) => {
			if (node.kind === "embed") nodes.push(node);
		});
		nodes.sort((a, b) => a.line - b.line);

		embeds.forEach((embed, i) => this.decorateEmbed(embed, nodes[i] ?? null, hostFile));
	}

	private decorateEmbed(
		embed: HTMLElement,
		node: ForesterNode | null,
		hostFile: TFile,
	): void {
		const target = this.embedTarget(embed, hostFile.path);
		const doc = embed.ownerDocument;

		const numberPath = node ? joinNumber(ancestorNumber(embed), node.localPath) : "";
		const shouldNumber = node?.shouldNumber ?? false;

		// Re-run cheaply when only the ambient number changed.
		const existing = embed.querySelector<HTMLElement>(":scope > .forester-header");
		if (existing) {
			if (embed.getAttribute("data-forester-number") === numberPath) return;
			existing.remove();
		}

		const title =
			node?.title ?? this.titleOf(target) ?? embed.getAttribute("src") ?? "";
		const meta = node?.meta ?? {};
		const uri = node?.uri ?? (target ? treeIdOf(target) : undefined);

		const header = buildHeader(doc, title, {
			numberPath: shouldNumber && this.settings.numberSubtrees ? numberPath : "",
			taxon: meta.taxon,
			meta,
			uri,
			isRoot: false,
		});

		header.addEventListener("click", (event) => {
			const el = event.target as HTMLElement;
			if (el.closest("a")) return;
			embed.toggleClass("forester-collapsed", !embed.hasClass("forester-collapsed"));
		});

		embed.addClass("block");
		embed.setAttribute(DONE, "embed");
		embed.setAttribute("data-forester-number", numberPath);
		if (meta.taxon) embed.setAttribute("data-taxon", meta.taxon);
		if (node) setDepth(embed, depthOf(node));

		embed.prepend(header);

		const slug = header.querySelector<HTMLElement>("a.slug");
		if (slug) this.wireSlug(slug, target?.path ?? uri ?? "", hostFile.path);

		this.hideDuplicateTitle(embed, title);
	}

	/**
	 * `[slug]` is the tree's address, so it behaves like any other internal
	 * link: click to open, mod-click or middle-click for a new tab, hover for a
	 * page preview.
	 */
	private wireSlug(slug: HTMLElement, linktext: string, sourcePath: string): void {
		if (linktext.length === 0) return;

		slug.addClass("internal-link");
		slug.setAttribute("href", linktext);
		slug.setAttribute("data-href", linktext);

		slug.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(event));
		});

		slug.addEventListener("auxclick", (event) => {
			if (event.button !== 1) return;
			event.preventDefault();
			event.stopPropagation();
			this.app.workspace.openLinkText(linktext, sourcePath, "tab");
		});

		slug.addEventListener("mouseover", (event) => {
			this.app.workspace.trigger("hover-link", {
				event,
				source: "preview",
				hoverParent: slug.parentElement,
				targetEl: slug,
				linktext,
				sourcePath,
			});
		});
	}

	/** The transcluded tree's `\title` is shown once, in the header we built. */
	private hideDuplicateTitle(embed: HTMLElement, title: string): void {
		const content = embed.querySelector<HTMLElement>(".markdown-embed-content");
		if (!content) return;
		const first = content.querySelector<HTMLElement>("h1");
		if (first && first.textContent?.trim() === title.trim()) {
			first.addClass("forester-promoted-title");
		}
	}

	private titleOf(file: TFile | null): string | null {
		if (!file) return null;
		const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
		if (headings.length > 0 && headings[0].level === 1) return headings[0].heading;
		return treeIdOf(file);
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Cheap relevance test for a mutation batch. Typing produces a steady stream of
 * `.cm-line` edits whose target has no `.internal-embed` ancestor, so those cost
 * one `closest()` call and nothing more.
 */
function touchesEmbed(mutations: MutationRecord[]): boolean {
	for (const mutation of mutations) {
		const target = mutation.target;
		if (target instanceof HTMLElement && target.closest(".internal-embed")) return true;

		for (const node of Array.from(mutation.addedNodes)) {
			if (!(node instanceof HTMLElement)) continue;
			if (node.matches(".internal-embed") || node.querySelector(".internal-embed")) {
				return true;
			}
		}
	}
	return false;
}

function setDepth(el: HTMLElement, depth: number): void {
	el.style.setProperty("--forester-depth", String(depth));
	el.addClass("forester-indented");
}

function visit(node: ForesterNode, fn: (node: ForesterNode) => void): void {
	for (const child of node.children) {
		fn(child);
		visit(child, fn);
	}
}

/** Depth below the document root; the root's own children are at depth 1. */
function depthOf(node: ForesterNode): number {
	return node.localPath.length === 0 ? 0 : node.localPath.split(".").length;
}

function depthAtLine(tree: DocumentTree, line: number): number {
	let depth = 0;
	let best = -1;
	visit(tree.root, (node) => {
		if (node.kind === "heading" && node.line <= line && node.line > best) {
			best = node.line;
			depth = depthOf(node);
		}
	});
	return depth;
}

/**
 * A transcluded tree keeps numbering in the *host* page's sequence, so the
 * ambient prefix has to cross the document boundary. The DOM is the only place
 * that relationship exists, so read it back from the enclosing block.
 */
function ancestorNumber(el: HTMLElement): string {
	const ancestor = el.parentElement?.closest<HTMLElement>("[data-forester-number]");
	return ancestor?.getAttribute("data-forester-number") ?? "";
}

function joinNumber(prefix: string, local: string): string {
	if (prefix.length === 0) return local;
	if (local.length === 0) return prefix;
	return prefix + "." + local;
}
