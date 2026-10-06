import {
	Component,
	Editor,
	Keymap,
	MarkdownPostProcessorContext,
	MarkdownRenderer,
	Notice,
	Platform,
	Plugin,
	TFile,
	debounce,
} from "obsidian";

import {
	buildDocumentTree,
	resolveByFilename,
	fileStem,
	identityOf,
	BLOCK_ANCHOR,
	IDENTITY,
	MINT_REQUEST,
	subtreeSpans,
	type DocumentTree,
	type ForesterNode,
	type Forest,
	type TargetRange,
} from "./forest";
import { buildHeader, buildSlug, buildTaxonSpan, buildMetadata } from "./render";
import { taxonWithNumber } from "./forest";
import {
	anchorNamedSubtrees,
	checkDirectives,
	checkPolicy,
	fulfilRequests,
	mint,
	anchorHeading,
	headingRefs,
	preferHeadingAnchors,
	retargetHeadingRefs,
} from "./mint";
import { DEFAULT_SETTINGS, ForesterSettingTab, type ForesterSettings } from "./settings";
import { HybridController } from './hybrid-controller';
import { hybridOptions } from './hybrid-config';

/** Marks elements we have already rewritten so passes stay idempotent. */
const DONE = "data-forester";
/** The range an embed is supposed to be showing, so a lost one can be spotted. */
const RANGE = "data-forester-range";
/** A heading's own number, before the ambient prefix of any block around it. */
const LOCAL = "data-forester-local";

export default class ForesterPlugin extends Plugin {
	settings: ForesterSettings = { ...DEFAULT_SETTINGS };
  private hybridController?: HybridController;

	private trees = new Map<string, { source?: string; tree: DocumentTree }>();
	/** Raw text per note. Directives live in comments, which the cache drops. */
	private sources = new Map<string, string>();
	private reading = new Set<string>();
	/** One `Component` per spliced-in range, so its renderer can be torn down. */
	private renderers = new WeakMap<HTMLElement, Component>();
	private observer: MutationObserver | null = null;
	/** Set when a tree changed underneath us, forcing a full re-number. */
	private dirty = true;
	private rescan: () => void = () => undefined;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applySettingsToDom();
    this.hybridController = new HybridController(this, () => this.settings.hybrid, () => this.settings.treeLinkSuggest !== false);
    const hybridReady = this.hybridController.initialize();

		// All Markdown rendering is controller-owned; excluded paths remain native.

		this.addCommand({
			id: "mint-note-address",
			name: "Mint address for this note",
			editorCallback: (_editor, view) => this.mintNoteAddress(view.file).catch(error => {
        console.error('Forester: failed to mint note address', error);
        new Notice(`Forester: note address mint failed — ${error instanceof Error ? error.message : String(error)}`);
      }),
		});
		this.addCommand({
			id: "mint-subtree-address",
			name: "Mint address for subtree at cursor",
			editorCallback: (editor, view) => this.mintSubtreeAddress(editor, view.file).catch(error => {
        // Native editor callbacks need not await their result; always handle the async IO failure here.
        console.error('Forester: failed to mint subtree address', error);
        new Notice(`Forester: subtree address mint failed — ${error instanceof Error ? error.message : String(error)}`);
      }),
		});

		this.addCommand({
			id: "lint-note",
			name: "Lint this note",
			// What Linter's custom commands call, and what makes "when something
			// else asks" mean anything. Asking is itself a request, so a mode of
			// `off` still fills in what the note asked for.
			callback: () => {
				const mode = this.settings.mintOnSave;
				void this.lintActiveNote(mode === "off" ? "requests" : mode);
			},
		});

		this.addCommand({
			id: "retarget-heading-references",
			name: "Rewrite heading references to addresses",
			callback: () => {
				void this.retargetVault().then((fixed) => {
					new Notice(
						fixed > 0
							? `Forester: corrected ${fixed} heading reference${fixed > 1 ? "s" : ""}`
							: "Forester: no heading reference to correct",
					);
				});
			},
		});

		this.applySaveHook();

		this.addSettingTab(new ForesterSettingTab(this.app, this));
		// No document-wide legacy observer or scan is started.

    // Native registrations are synchronous; indexing yields cooperatively.
    await hybridReady;
	}

	onunload(): void {
		this.observer?.disconnect();
		document.body.removeClass("forester-enabled", "forester-mobile");
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.hybrid = hybridOptions(this.settings.hybrid);
		// Briefly spelled `all`, when it also addressed every heading.
		if ((this.settings.mintOnSave as string) === "all") this.settings.mintOnSave = "notes";
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
    await this.hybridController?.refresh();
		this.applySettingsToDom();
		this.applySaveHook();
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

	private treeFor(file: TFile): DocumentTree | null {
		const source = this.sourceOf(file);
    // The hybrid controller owns these files; legacy identity/metadata rules must not rewrite them.
    if (this.hybridController) return null;

		// Directives live in HTML comments, which the metadata cache drops, so a
		// tree built with the raw text supersedes one built without it.
		const cached = this.trees.get(file.path);
		if (cached && cached.source === source) return cached.tree;

		const tree = buildDocumentTree(this.app, file, source, this.forest);
		if (tree) this.trees.set(file.path, { source, tree });
		return tree;
	}

	/**
	 * The forest as the plugin sees it. Only this side can answer the identity
	 * questions: `getFirstLinkpathDest` looks notes up by file name, and an
	 * identity is exactly the thing that is not the file name.
	 */
	private forest: Forest = {
		sourceOf: (file) => this.sourceOf(file),
		identityOf: (file) => identityOf(this.app, file),
		resolve: (target, from) => this.resolveTarget(target, from),
	};

	/**
	 * The ladder tree-md resolves by, in its order. Identities are tried before
	 * file names, so a tree whose `id` happens to match another tree's file name
	 * still wins; `.tree` is retried off because that is the spelling Obsidian
	 * autocompletes for `foo.tree.md`.
	 */
	private resolveTarget(target: string, from: TFile): TFile | null {
		const bare = target.replace(/\.tree$/, "");

		const byIdentity = this.identities.get(target) ?? this.identities.get(bare);
		if (byIdentity) return byIdentity;

		// Obsidian's own lookup covers file names, including the folder-qualified
		// spelling it writes when two notes share one.
		return resolveByFilename(this.app, target, from);
	}

	/**
	 * Identity to note, for the whole vault. Rebuilt lazily: it is only wrong
	 * after a note's front matter changes, and that arrives as a cache event.
	 */
	private identities = new Map<string, TFile>();
	private indexStale = true;

	private refreshIndex(): void {
		if (!this.indexStale) return;
		this.indexStale = false;

		this.identities.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const identity = identityOf(this.app, file);
			// A duplicate identity is an error in tree-md; here the first one wins
			// so that the ambiguity shows up as one address rather than none.
			if (!this.identities.has(identity)) this.identities.set(identity, file);
		}
	}

	// ── minting ───────────────────────────────────────────────────────────────

	/**
	 * Obsidian has no "saved" event — it writes continuously — so the only thing
	 * that means *the author stopped* is the save command itself. Wrapping it is
	 * how a linter gets that moment, and the wrapper is put back on unload.
	 */
	private unhookSave: (() => void) | null = null;

	applySaveHook(): void {
		this.unhookSave?.();
		this.unhookSave = null;
		if (this.hybridController || this.settings.lintTrigger !== "save") return;

		const commands = (
			this.app as unknown as {
				commands?: { commands?: Record<string, { callback?: () => unknown }> };
			}
		).commands?.commands;
		const save = commands?.["editor:save-file"];
		if (!save) return;

		const original = save.callback;
		save.callback = () => {
			const result = original?.();
			void this.lintActiveNote(this.settings.mintOnSave);
			return result;
		};
		this.unhookSave = () => {
			save.callback = original;
			this.unhookSave = null;
		};
		this.register(() => this.unhookSave?.());
	}

  /** Legacy writes respect raw disk text and every open editor's unsaved opt-in. */
  private hybridOwns(file: TFile, source: string): boolean {
    const controller = this.hybridController;
    if (!controller) return false;
    // Disabled means excluded/native, never a grant for the old mutation pipeline.
    if (file.extension === "md") return true;
    if (controller.isEnabled(file.path, source)) return true;

    const editors = new Set<Editor>();
    let unreadable = false;
    const collect = (info: { file?: TFile | null; editor?: Editor } | null | undefined): void => {
      if (info?.file?.path !== file.path) return;
      try {
        const editor = info.editor;
        if (editor) editors.add(editor);
      } catch {
        unreadable = true; // A known matching buffer cannot grant permission when unavailable.
      }
    };
    const workspace = this.app.workspace;
    collect(workspace.activeEditor);
    const leaves = new Set(workspace.getLeavesOfType('markdown'));
    workspace.iterateAllLeaves?.(leaf => leaves.add(leaf));
    for (const leaf of leaves) {
      collect(leaf.view as { file?: TFile | null; editor?: Editor });
    }
    if (unreadable) return true;
    return [...editors].some(editor => {
      let live: string;
      try { live = editor.getValue(); } catch { return true; }
      // Keep parser/legacy errors outside the editor-access catch.
      return typeof live !== 'string' || controller.isEnabled(file.path, live);
    });
  }

  private async writeLegacyNoteAddress(file: TFile, address: string): Promise<boolean> {
    const refused = new Error('Hybrid-owned note');
    try {
      await this.app.fileManager.processFrontMatter(file, frontmatter => {
        // This API supplies current parsed frontmatter, not raw text. JSON flow mappings are YAML.
        const mode = `---\n${JSON.stringify({ 'forester-mode': frontmatter['forester-mode'] })}\n---\n`;
        // Throw to stop native serialization too, even if the callback did not change any keys.
        if (this.hybridOwns(file, mode)) throw refused;
        frontmatter['id'] = address;
      });
      return true;
    } catch (error) {
      if (error === refused) return false;
      throw error;
    }
  }

	/**
	 * Fill in the addresses this note asked for. Only ever additive: an address
	 * that is written is never minted over, and on `requests` nothing that stated
	 * no address is given one, so no existing address moves.
	 */
	private async lintActiveNote(mode: ForesterSettings["mintOnSave"]): Promise<void> {
    if (this.hybridController) { await this.hybridController.saveActive(); return; }
		if (mode === "off") return;

		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return;
    if (this.hybridOwns(file, await this.app.vault.read(file))) return;

		const policy = this.settings.address;
		if (checkPolicy(policy) !== null) return;

		const taken = this.takenAddresses();
		const draw = (): string => {
			const address = mint(taken, policy);
			// Within one pass the vault has not been re-read, so each address has
			// to be held back by hand or two requests take the same one.
			taken.add(address);
			return address;
		};

		let minted = 0;

		const declared = this.app.metadataCache.getFileCache(file)?.frontmatter?.["id"];
		const stated = typeof declared === "string" && IDENTITY.test(declared);
		const asked = "id" in (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {});
		if (!stated && (asked || mode === "notes")) {
			const address = draw();
			if (await this.writeLegacyNoteAddress(file, address)) minted++;
		}

		// Requests in the body, which the front-matter pass cannot see.
		let problems: string[] = [];
		await this.app.vault.process(file, (data) => {
      if (this.hybridOwns(file, data)) return data;
			const lines = data.split("\n");

			// Names first: a heading named by a directive is moved onto the heading,
			// which is the only spelling Obsidian can address, and that consumes the
			// bare `<!-- id -->` request too.
			minted += preferHeadingAnchors(lines, draw);
			minted += fulfilRequests(lines, draw);
			anchorNamedSubtrees(lines);
			problems = checkDirectives(lines);

			const after = lines.join("\n");
			if (after === data) return data;
			this.recordSource(file.path, after);
			return after;
		});

		// A `#Heading` reference to a section that has no address: the reference is
		// itself the request, and the only place an address can go is that heading,
		// which is usually in another note. Done before the rewrite so that every
		// reference has something to be rewritten to.
		minted += await this.addressReferencedHeadings(file, draw);

		let fixed = 0;
		await this.app.vault.process(file, (data) => {
      if (this.hybridOwns(file, data)) return data;
			const lines = data.split("\n");
			fixed = retargetHeadingRefs(lines, (path, heading) =>
				this.retargetOf(file, path, heading),
			);
			if (fixed === 0) return data;

			const after = lines.join("\n");
			this.recordSource(file.path, after);
			return after;
		});

		// The references that had to be corrected mostly live elsewhere: the note
		// holding the heading is rarely the note pointing at it.
		if (minted > 0) fixed += await this.retargetVault(file);

		const said: string[] = [];
		if (minted > 0) said.push(`minted ${minted} address${minted > 1 ? "es" : ""}`);
		if (fixed > 0) said.push(`corrected ${fixed} heading reference${fixed > 1 ? "s" : ""}`);
		if (said.length > 0) new Notice(`Forester: ${said.join(", ")}`);

		// Reported, not repaired: each of these is a sentence whose meaning cannot
		// be guessed at, and tree-md will refuse the file until it is settled.
		for (const problem of problems.slice(0, 3)) {
			new Notice(`Forester: ${file.basename} ${problem}`, 8000);
		}
	}

	/**
	 * Give an address to every heading this note points at that has none.
	 *
	 * Writing `![[note#Section]]` is asking to address that section, and a section
	 * has no Forester address until its heading is given one. So the reference is
	 * the request — the only one that reaches into another note, which is why the
	 * address has to be written there rather than here.
	 */
	private async addressReferencedHeadings(from: TFile, draw: () => string): Promise<number> {
		const text = await this.app.vault.read(from);
    // The source may have opted in while the caller's earlier IO was pending.
    if (this.hybridOwns(from, text)) return 0;
		let minted = 0;
		const done = new Set<string>();

		for (const ref of headingRefs(text.split("\n"))) {
			const key = `${ref.path}#${ref.heading}`;
			if (done.has(key)) continue;
			done.add(key);

			const target =
				ref.path.length === 0 ? from : this.resolveTarget(ref.path, from);
			if (!target || target.extension !== "md") continue;
      if (this.hybridOwns(target, await this.app.vault.read(target))) continue;

			// Read it now rather than asking and settling next time: the answer is
			// needed in this pass, and a reference the author just wrote is exactly
			// the case where the note it points at has never been opened.
			if (this.sources.get(target.path) === undefined) {
				this.recordSource(target.path, await this.app.vault.cachedRead(target));
			}

			// Already addressed, the root's own title, or not a heading that
			// exists: nothing to address.
			if (this.addressOfHeading(from, ref.path, ref.heading) !== null) continue;
			if (this.isRootTitle(from, ref.path, ref.heading)) continue;

      // Retire a stale request, including a saved opt-in made during target IO.
      const currentFrom = await this.app.vault.read(from);
      if (currentFrom !== text || this.hybridOwns(from, currentFrom)) break;
			const address = draw();
			let placed = false;
			await this.app.vault.process(target, (data) => {
        if (this.hybridOwns(from, text) || this.hybridOwns(target, data)) return data;
				const lines = data.split("\n");
				placed = anchorHeading(lines, ref.heading, address);
				if (!placed) return data;

				// Into our own cache at once. The metadata cache catches up a second
				// or two later, and the rewrite that reads this address back happens
				// in the next breath — reading the stale text there is exactly why
				// the reference was left pointing at the heading.
				const written = lines.join("\n");
				this.recordSource(target.path, written);
				return written;
			});

			if (placed) minted++;
		}

		return minted;
	}

	/**
	 * What `path#heading` should have been written as.
	 *
	 * A `#` title is the root `\title` — the tree itself, not a section of it —
	 * so the fragment simply goes: `![[research.tree#研究]]` is `![[research.tree]]`
	 * said the long way. Anything deeper is a subtree, and is addressed by the
	 * anchor it carries. A reference into the same note has no path to fall back
	 * on, so a root title there is left alone.
	 */
	private retargetOf(from: TFile, path: string, heading: string): string | null {
		const address = this.addressOfHeading(from, path, heading);
		if (address !== null) return `${path}#^${address}`;
		if (path.length > 0 && this.isRootTitle(from, path, heading)) return path;
		return null;
	}

	private isRootTitle(from: TFile, path: string, heading: string): boolean {
		const target = path.length === 0 ? from : this.resolveTarget(path, from);
		if (!target) return false;

		const headings = this.app.metadataCache.getFileCache(target)?.headings ?? [];
		const first = headings[0];
		return (
			first !== undefined &&
			first.level === 1 &&
			first.heading.trim().toLowerCase() === heading.trim().toLowerCase()
		);
	}

	/**
	 * The address the heading `heading` carries in the note `path` names, if it
	 * has been given one. `path` is empty for a reference into the same note.
	 */
	private addressOfHeading(from: TFile, path: string, heading: string): string | null {
		const target = path.length === 0 ? from : this.resolveTarget(path, from);
		if (!target || target.extension !== "md") return null;

		const source = this.sourceOf(target);
		if (source === undefined) return null;

		const wanted = heading.trim().toLowerCase();
		for (const span of subtreeSpans(source)) {
			if (!span.titled || span.id === undefined || span.title === undefined) continue;
			if (span.title.trim().toLowerCase() === wanted) return span.id;
		}
		return null;
	}

	/** Correct `#Heading` references across the vault, wherever they live. */
	private async retargetVault(skip?: TFile): Promise<number> {
		let fixed = 0;

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file === skip) continue;
			// Only notes we hold the text of; the rest are asked for and settle on
			// a later pass rather than being read synchronously here.
			if (this.sources.get(file.path) === undefined) continue;
      if (this.hybridOwns(file, await this.app.vault.read(file))) continue;

			await this.app.vault.process(file, (data) => {
        if (this.hybridOwns(file, data)) return data;
				const lines = data.split("\n");
				const count = retargetHeadingRefs(lines, (path, heading) =>
					this.addressOfHeading(file, path, heading),
				);
				if (count === 0) return data;
				fixed += count;
				return lines.join("\n");
			});
		}

		return fixed;
	}

	/**
	 * Every identity the forest already answers to: note ids, note file names,
	 * and subtree ids. They share one namespace, and an address that is written
	 * is never minted over, so this set is the only thing a new one must miss.
	 */
	private takenAddresses(): Set<string> {
		this.refreshIndex();
		const taken = new Set<string>();

		for (const file of this.app.vault.getMarkdownFiles()) {
			taken.add(identityOf(this.app, file));
			taken.add(fileStem(file));

			// Subtree ids only exist in the raw text. A note we have not read is
			// one we cannot clear, so ask for it — a second run will see it.
			const source = this.sourceOf(file);
			if (source === undefined) continue;
			for (const id of subtreeIds(source)) taken.add(id);
		}

		return taken;
	}

	private newAddress(): string | null {
		const policy = this.settings.address;
		const problem = checkPolicy(policy);
		if (problem) {
			new Notice(`Forester: address policy is unusable — ${problem}`);
			return null;
		}
		return mint(this.takenAddresses(), policy);
	}

	/**
	 * Write an `id` into this note's front matter. A note that already states one
	 * keeps it: the whole point of an address is that nothing moves it.
	 */
	private async mintNoteAddress(file: TFile | null): Promise<void> {
		if (!file) return;
    if (this.hybridController) {
      const editor = this.app.workspace.activeEditor?.editor;
      if (editor) await this.hybridController.mintNoteAddress(editor, file);
      return;
    }
    if (this.hybridOwns(file, await this.app.vault.read(file))) return;

		const declared = this.app.metadataCache.getFileCache(file)?.frontmatter?.["id"];
		if (typeof declared === "string" && IDENTITY.test(declared)) {
			new Notice(`Forester: this note is already ${declared}`);
			return;
		}

		const address = this.newAddress();
		if (!address) return;

		if (!await this.writeLegacyNoteAddress(file, address)) return;
		new Notice(`Forester: minted ${address}`);
	}

	/**
	 * Name the subtree the cursor is in. A heading takes the anchor spelling —
	 * `## Heading ^NNNN` — because that is the one Obsidian can also address; a
	 * `<!-- id -->` request is answered in place.
	 */
	private async mintSubtreeAddress(editor: Editor, file: TFile | null): Promise<void> {
    // Without a bound file there is no saved ownership to verify (native ctx.file may be null).
    if (!file) return;
    if (this.hybridController) { await this.hybridController.mintSubtreeAddress(editor, file); return; }
    const workspace = this.app.workspace, path = file.path;
    let active: typeof workspace.activeEditor, before: string, cursor: { line: number; ch: number };
    try {
      active = workspace.activeEditor;
      before = editor.getValue();
      cursor = { ...editor.getCursor() };
    } catch { return; }
    // The same view can be reused for a different note while native IO is pending.
    const stillCurrent = (): boolean => {
      try {
        const current = editor.getCursor();
        return workspace.activeEditor === active && active?.editor === editor &&
          active.file?.path === path && file.path === path && editor.getValue() === before &&
          current.line === cursor.line && current.ch === cursor.ch;
      } catch { return false; }
    };
    const source = await this.app.vault.read(file);
    if (!stillCurrent() || this.hybridOwns(file, source)) return;
    // Resample raw disk after the first async read; this is not a filesystem transaction.
    const latest = await this.app.vault.read(file);
    if (latest !== source || !stillCurrent() || this.hybridOwns(file, latest)) return;
		const opener = this.subtreeOpenerAt(editor, cursor.line);
		if (opener === null) {
			new Notice("Forester: no subtree opens above the cursor");
			return;
		}

		const text = editor.getLine(opener).replace(/[ \t]+$/, "");
		// Every spelling that already carries a name, including `<!-- hN:ID -->`.
		if (BLOCK_ANCHOR.test(text) || /^<!--\s*(?:subtree|id|h[2-6])\s*:/.test(text)) {
			new Notice("Forester: this subtree already has an address");
			return;
		}

		const address = this.newAddress();
		if (!address) return;

		const untitled = text.match(/^<!--\s*(h[2-6])\s*-->$/);
		const replacement = MINT_REQUEST.test(text)
			? `<!-- id: ${address} -->`
			: untitled
				? `<!-- ${untitled[1]}:${address} -->`
				: `${text} ^${address}`;

		if (replacement === text) {
			new Notice("Forester: nothing to name here");
			return;
		}

    if (this.hybridOwns(file, latest) || !stillCurrent()) return;
		editor.setLine(opener, replacement);

		// A directive names the subtree for tree-md, but Obsidian addresses a
		// subtree only through an anchor: without one the address is write-only
		// from this side — no `![[note#^id]]`, no autocomplete, no backlink. A
		// heading carries its own anchor; an untitled subtree needs the first
		// block of its body to carry it.
		if (untitled) this.anchorFirstBlock(editor, opener, address);

		new Notice(`Forester: minted ${address}`);
	}

	private anchorFirstBlock(editor: Editor, opener: number, address: string): void {
		for (let i = opener + 1; i < editor.lineCount(); i++) {
			const text = editor.getLine(i).replace(/[ \t]+$/, "");
			if (text.length === 0) continue;
			// The body ran out before any of it did: nothing to anchor.
			if (/^#{1,6}\s/.test(text) || /^<!--\s*\/?h[2-6]/.test(text)) return;
			if (BLOCK_ANCHOR.test(text)) return;
			editor.setLine(i, `${text} ^${address}`);
			return;
		}
	}

	/** The heading or directive that opens the subtree the cursor sits in. */
	private subtreeOpenerAt(editor: Editor, line: number): number | null {
		for (let i = line; i >= 0; i--) {
			const text = editor.getLine(i).replace(/[ \t]+$/, "");
			if (/^#{2,6}\s+\S/.test(text)) return i;
			if (/^<!--\s*h[2-6](?::|\s*-->)/.test(text)) return i;
			if (MINT_REQUEST.test(text)) return i;
		}
		return null;
	}

	/**
	 * The range of a transcluded subtree is delimited by `<!-- /hN -->`, which
	 * only exists in the raw text — so a note we transclude *out of* has to be
	 * read even when it is not open. Pull it in once and rescan when it lands;
	 * until then the embed keeps whatever Obsidian rendered.
	 */
	private sourceOf = (file: TFile): string | undefined => {
		const cached = this.sources.get(file.path);
		if (cached !== undefined) return cached;
		if (this.reading.has(file.path)) return undefined;

		this.reading.add(file.path);
		this.app.vault
			.cachedRead(file)
			.then((text) => {
				this.reading.delete(file.path);
				this.recordSource(file.path, text);
			})
			.catch(() => this.reading.delete(file.path));

		return undefined;
	};

	/**
	 * The one way a note's text enters the plugin. It has to be the only way,
	 * because every cached tree that transcludes a subtree of this note gave up
	 * on that embed while the text was missing, and nothing about *their* source
	 * changes to tell them to look again. The reading-view pass records text too,
	 * and routing it around this is what left those embeds stuck.
	 */
	private recordSource(path: string, text: string): void {
		if (this.sources.get(path) === text) return;
		this.sources.set(path, text);
		this.trees.clear();
		this.dirty = true;
		this.rescan();
	}

	private fileFor(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	// ── reading view ──────────────────────────────────────────────────────────

	private processReadingSection(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		const file = this.fileFor(ctx.sourcePath);
		if (!file) return;

		this.refreshIndex();
		const tree = this.treeFor(file);
		if (!tree) return;

		// Section info is only about this note when this note is what is being
		// rendered. Inside an embed the text is whatever Obsidian extracted — for
		// a `#^id` embed, the single anchored block — and its line numbers count
		// from the start of that extract, not of the note.
		const info = el.closest(".internal-embed") ? null : ctx.getSectionInfo(el);

		const headings = Array.from(
			el.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6"),
		).filter((h) => !h.closest(".internal-embed"));

		for (const heading of headings) {
			const level = Number(heading.tagName.substring(1));
			const node = this.nodeForHeading(tree, heading, level, info?.lineStart);
			this.decorateHeading(heading, tree, node, level, file);
		}

		if (headings.length === 0 && info) {
			// A directive-opened subtree has no heading to decorate, so its
			// header goes on the first block of its body.
			const source = this.sources.get(file.path);
			const node = source ? subtreeOpeningAt(tree, source, info.lineStart) : null;
			if (node) this.decorateSubtree(el, node, file);

			// Indent ordinary blocks to the depth of the subtree they belong to.
			const depth = depthAtLine(tree, info.lineStart);
			if (depth > 0) setDepth(el, depth);
		}
	}

	/**
	 * `<!-- h2:aside -->` renders to nothing at all, so the taxon, number and
	 * `[slug]` an untitled subtree is entitled to go above the first block that
	 * does render. Everything below is indented by `depthAtLine`.
	 */
	private decorateSubtree(el: HTMLElement, node: ForesterNode, file: TFile): void {
		if (el.hasAttribute(DONE)) return;
		el.setAttribute(DONE, "subtree");

		const doc = el.ownerDocument;
		const numberPath = joinNumber(ancestorNumber(el), node.localPath);
		const header = buildHeader(doc, "", {
			numberPath: node.shouldNumber && this.settings.numberSubtrees ? numberPath : "",
			meta: {},
			uri: node.uri,
			isRoot: false,
		});

		// Unnamed and unnumbered, there is nothing to show: the subtree is a
		// grouping, and the indentation alone conveys it.
		if (!header.textContent) return;

		el.setAttribute("data-forester-number", numberPath);
		el.addClass("forester-subtree-marker");
		el.prepend(header);

		// An untitled subtree can only be jumped to through the `^id` anchor that
		// names it for Obsidian. Without one the address is still worth printing,
		// but there is nowhere for it to lead.
		const slug = header.querySelector<HTMLElement>("a.slug");
		const anchored =
			node.uri !== undefined &&
			this.app.metadataCache.getFileCache(file)?.blocks?.[node.uri] !== undefined;
		if (slug && anchored) this.wireSlug(slug, `${file.path}#^${node.uri}`, file.path);
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
		// The ambient prefix can arrive after this: a heading inside a transcluded
		// note is rendered — and decorated — before the block around it knows its
		// own number. Keeping the part that is this document's own lets the whole
		// path be rebuilt once the block does.
		if (taxon) {
			heading.setAttribute(LOCAL, node.localPath);
			if (node.meta.taxon) heading.setAttribute("data-forester-taxon", node.meta.taxon);
		}
	}

	/**
	 * Rebuild every number whose ambient prefix has changed.
	 *
	 * Numbering crosses a transclusion boundary — a heading inside a transcluded
	 * note continues the host page's sequence — and the DOM is the only place that
	 * relationship exists. It is also built in the wrong order for it: Obsidian
	 * renders the embed's contents first and the block around them second, so the
	 * headings inside are numbered before there is a prefix to read.
	 */
	private renumberHeadings(): void {
		for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${LOCAL}]`))) {
			const local = el.getAttribute(LOCAL) ?? "";
			const numberPath = joinNumber(ancestorNumber(el), local);
			if (el.getAttribute("data-forester-number") === numberPath) continue;

			el.setAttribute("data-forester-number", numberPath);
			const span = el.querySelector<HTMLElement>(":scope > span.taxon");
			if (span) {
				span.textContent = taxonWithNumber(
					el.getAttribute("data-forester-taxon") ?? undefined,
					numberPath,
				);
			}
		}
	}

	// ── transclusions ─────────────────────────────────────────────────────────

	private decorateEmbeds(): void {
		if (!this.settings.transclusionHeaders) return;
		this.refreshIndex();

		const embeds = Array.from(
			document.querySelectorAll<HTMLElement>(".internal-embed.markdown-embed.is-loaded"),
		);

		// Nothing new and nothing invalidated: skip the whole grouping pass.
		if (!this.dirty && embeds.every(isSettled)) return;
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

		// After the blocks, because their numbers are what the headings inside
		// them are numbered against.
		this.renumberHeadings();

		this.dumpDebug();
	}

	/**
	 * TEMPORARY. Writes what a scan actually saw to `.obsidian/forester-debug.json`,
	 * so the DOM Obsidian built and the tree the plugin built can be compared
	 * outside the app. Remove once the embed path is settled.
	 */
	private dumpDebug = debounce(() => {
		const dom = Array.from(
			document.querySelectorAll<HTMLElement>(".internal-embed"),
		).map((embed) => ({
			src: embed.getAttribute("src"),
			cls: embed.className,
			done: embed.getAttribute(DONE),
			number: embed.getAttribute("data-forester-number"),
			hasContent: embed.querySelector(":scope > .markdown-embed-content") !== null,
			contentCount: embed.querySelectorAll(":scope > .markdown-embed-content").length,
			range:
				embed
					.querySelector(".forester-range")
					?.getAttribute("data-forester-range") ?? null,
			header: embed.querySelector(":scope > .forester-header")?.textContent ?? null,
		}));

		const file = this.app.workspace.getActiveFile();
		const tree = file ? this.trees.get(file.path)?.tree : undefined;
		const nodes: unknown[] = [];
		if (tree) {
			visit(tree.root, (node) => {
				if (node.kind !== "embed") return;
				nodes.push({
					line: node.line,
					link: node.link,
					uri: node.uri,
					localPath: node.localPath,
					shouldNumber: node.shouldNumber,
					unresolved: node.unresolved ?? false,
					target: node.target ?? null,
				});
			});
		}

		void this.app.vault.adapter.write(
			".obsidian/forester-debug.json",
			JSON.stringify(
				{
					active: file?.path ?? null,
					builtWithSource: tree ? this.trees.get(file?.path ?? "")?.source !== undefined : null,
					sources: Array.from(this.sources.entries()).map(([path, text]) => ({
						path,
						lines: text.split("\n").length,
						chars: text.length,
						directives: text.match(/^<!--\s*\/?h[2-6].*-->/gm) ?? [],
					})),
					reading: Array.from(this.reading),
					nodes,
					dom,
				},
				null,
				2,
			),
		);
	}, 800, true);

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
		// `![[#^id]]` addresses the note the embed is written in.
		const path = src.split("#")[0];
		if (path.length === 0) return this.fileFor(hostPath);
		return this.app.metadataCache.getFirstLinkpathDest(path, hostPath);
	}

	private decorateGroup(hostFile: TFile, embeds: HTMLElement[]): void {
		const tree = this.treeFor(hostFile);
		if (!tree) return;

		const nodes: ForesterNode[] = [];
		visit(tree.root, (node) => {
			if (node.kind === "embed") nodes.push(node);
		});
		nodes.sort((a, b) => a.line - b.line);

		// Match on what each embed addresses, not on its position in the list.
		// Position only works while the tree holds a node for every embed in the
		// DOM and vice versa; one missing on either side — a target that has not
		// been indexed yet, an embed Obsidian has not built — silently hands every
		// embed after it its neighbour's node, and so its neighbour's header.
		const seen = new Map<string, number>();

		for (const embed of embeds) {
			const target = this.embedTarget(embed, hostFile.path);
			if (!target || target.extension !== "md") continue;

			const address = this.addressOf(embed.getAttribute("src") ?? "", hostFile);
			const nth = seen.get(address) ?? 0;
			seen.set(address, nth + 1);

			const matches = nodes.filter(
				(node) => this.addressOf(node.link ?? "", hostFile) === address,
			);
			this.decorateEmbed(embed, matches[nth] ?? null, hostFile);
		}
	}

	/**
	 * A link resolved to the note it names plus its subpath, so that the spelling
	 * in the source and the spelling in the `src` attribute compare equal.
	 */
	private addressOf(link: string, hostFile: TFile): string {
		const hash = link.indexOf("#");
		const path = hash < 0 ? link : link.slice(0, hash);
		const fragment = hash < 0 ? "" : link.slice(hash + 1);
		const file =
			path.length === 0
				? hostFile
				: this.app.metadataCache.getFirstLinkpathDest(path, hostFile.path);
		return `${file?.path ?? path}#${fragment}`;
	}

	private decorateEmbed(
		embed: HTMLElement,
		node: ForesterNode | null,
		hostFile: TFile,
	): void {
		// A `#…` embed we cannot place is left exactly as Obsidian drew it.
		// Dressing it as a `.block` would claim it is a transclusion, and it is
		// not one until the subtree behind it has been found.
		//
		// Deliberately unmarked. Every reason to land here is temporary — a note
		// still being read, an embed whose body Obsidian has not built yet — and
		// the scan's fast path skips any pass in which every embed is marked. An
		// embed marked on the way past would never be looked at again.
		if (node?.unresolved) return;

		const src = embed.getAttribute("src") ?? "";
		const target = this.embedTarget(embed, hostFile.path);
		const doc = embed.ownerDocument;

		const numberPath = node ? joinNumber(ancestorNumber(embed), node.localPath) : "";
		const shouldNumber = node?.shouldNumber ?? false;

		// Obsidian ends a `#heading` embed at the next heading and a `#^id` embed
		// after one block. tree-md ends both at `<!-- /hN -->`, so the body has to
		// be laid out again from the range the tree carries.
		const spliced = node?.target ? this.spliceRange(embed, node.target) : "untouched";
		if (spliced === "unavailable") return;
		// The link used to address a subtree and no longer does: hand the body
		// back to Obsidian rather than leaving a range nothing will refresh.
		if (spliced === "untouched" && embed.hasAttribute(RANGE)) this.dropRange(embed);

		// Re-run cheaply when only the ambient number changed.
		const existing = embed.querySelector<HTMLElement>(":scope > .forester-header");
		if (existing) {
			const settled = embed.getAttribute("data-forester-number") === numberPath;
			if (settled && spliced !== "rendered") return;
			existing.remove();
		}

		const isFragment = node?.fragment !== undefined;
		const title =
			node?.title ?? this.titleOf(target) ?? embed.getAttribute("src") ?? "";
		const meta = node?.meta ?? {};
		// A subtree's address is its own id or nothing; only a whole-tree
		// transclusion may fall back to the note's.
		const uri = isFragment
			? node?.uri
			: node?.uri ?? (target ? identityOf(this.app, target) : undefined);

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

		if (header.textContent) embed.prepend(header);

		const slug = header.querySelector<HTMLElement>("a.slug");
		// A subtree is addressed through the note that holds it, which is the
		// spelling already in `src`.
		if (slug) {
			this.wireSlug(slug, isFragment ? src : target?.path ?? uri ?? "", hostFile.path);
		}

		if (!isFragment) this.hideDuplicateTitle(embed, title);
	}

	/**
	 * Replace an embed's body with the exact lines the transcluded subtree spans.
	 * Idempotent: a range already in place is left alone, so the observer can run
	 * as often as it likes.
	 */
	/** Undo a splice, giving Obsidian's own body back. */
	private dropRange(embed: HTMLElement): void {
		const previous = this.renderers.get(embed);
		if (previous) {
			this.removeChild(previous);
			this.renderers.delete(embed);
		}
		embed.querySelector<HTMLElement>(":scope > .forester-range")?.remove();
		embed.removeAttribute(RANGE);
		embed.removeClass("forester-spliced");
	}

	private spliceRange(
		embed: HTMLElement,
		range: TargetRange,
	): "rendered" | "unchanged" | "unavailable" {
		const signature = `${range.path}:${range.start}-${range.end}`;
		const current = embed.querySelector<HTMLElement>(":scope > .forester-range");
		if (current?.getAttribute("data-forester-range") === signature) return "unchanged";

		const text = this.sources.get(range.path);
		if (text === undefined) return "unavailable";

		// A subtree that transcludes itself, directly or through another note,
		// would recurse forever: Obsidian's own guard cannot see a range we
		// spliced in ourselves.
		if (enclosedBy(embed, signature)) return "unavailable";

		const previous = this.renderers.get(embed);
		if (previous) {
			this.removeChild(previous);
			this.renderers.delete(embed);
		}
		current?.remove();

		const body = stripBlockIds(
			text.split("\n").slice(range.start, range.end).join("\n"),
		).trim();

		// Alongside Obsidian's own body rather than inside it. Obsidian rebuilds
		// `.markdown-embed-content` whenever it feels like it — on load, on a
		// cache change — and anything of ours in there goes with it, which is the
		// fight the last few rounds were losing. It also means we no longer wait
		// for that div to exist: `is-loaded` goes on before it is built.
		const holder = embed.createDiv({ cls: "forester-range" });
		holder.setAttribute("data-forester-range", signature);
		embed.setAttribute(RANGE, signature);
		embed.addClass("forester-spliced");

		const component = new Component();
		this.addChild(component);
		this.renderers.set(embed, component);

		// The path is the *target's*, so links and nested embeds inside the range
		// resolve against the note that owns them.
		void MarkdownRenderer.render(this.app, body, holder, range.path, component);
		return "rendered";
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
		if (!first) return;

		// Whichever pass got there first: before the reading-view pass decorates
		// it the text is the bare title, and after it the taxon and the `[slug]`
		// are in there too, so the comparison stops matching.
		if (first.hasClass("forester-root-title") || first.textContent?.trim() === title.trim()) {
			first.addClass("forester-promoted-title");
		}
	}

	private titleOf(file: TFile | null): string | null {
		if (!file) return null;
		const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
		if (headings.length > 0 && headings[0].level === 1) return headings[0].heading;
		return fileStem(file);
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

/**
 * The subtree a `<!-- hN -->` opened, if this section is the first block of its
 * body. Obsidian renders the directive itself to nothing — and may not give it a
 * section at all — so the header has to hang off the first block that renders.
 */
function subtreeOpeningAt(
	tree: DocumentTree,
	text: string,
	line: number,
): ForesterNode | null {
	const lines = text.split("\n");
	let found: ForesterNode | null = null;

	visit(tree.root, (node) => {
		if (found || node.kind !== "subtree") return;
		for (let i = node.startLine + 1; i < node.endLine; i++) {
			if ((lines[i] ?? "").trim().length === 0) continue;
			if (i === line) found = node;
			return; // only the first block of the body counts
		}
	});

	return found;
}

/**
 * The deepest subtree whose range covers the line. Ranges rather than "the last
 * heading above" because `<!-- /hN -->` hands the lines after it back to the
 * parent, so a block can sit below a subtree without belonging to it.
 */
function depthAtLine(tree: DocumentTree, line: number): number {
	let depth = 0;
	visit(tree.root, (node) => {
		if (node.kind === "embed") return;
		if (line >= node.startLine && line < node.endLine) {
			depth = Math.max(depth, depthOf(node));
		}
	});
	return depth;
}

/**
 * `^id` is how Obsidian marks the block, not content, so it is stripped rather
 * than shown. Only a token at the end of a block counts, and only one that
 * starts the run or follows a space — `the value x^2` keeps its caret. A
 * paragraph that held nothing but an anchor leaves nothing behind.
 */
const TRAILING_ANCHOR = /(?:^|[ \t])\^[A-Za-z0-9][A-Za-z0-9._-]*[ \t]*$/gm;

function stripBlockIds(text: string): string {
	// An anchor on its own line leaves an empty one behind, and an empty line
	// between two blank ones would otherwise read as a paragraph of nothing.
	return text.replace(TRAILING_ANCHOR, "").replace(/\n{3,}/g, "\n\n");
}

/**
 * Is this embed still showing what we last gave it? `DONE` only records that we
 * decorated it once, and Obsidian rebuilds an embed's body on its own schedule
 * without disturbing the element or its attributes — so an embed can be marked
 * and yet have lost the range underneath it.
 */
function isSettled(embed: HTMLElement): boolean {
	if (!embed.hasAttribute(DONE)) return false;

	const wanted = embed.getAttribute(RANGE);
	if (wanted === null) return true;

	const range = embed.querySelector<HTMLElement>(":scope > .forester-range");
	return range?.getAttribute(RANGE) === wanted;
}

/** Every subtree id a note's text states, in any of the four spellings. */
function subtreeIds(source: string): string[] {
	const ids: string[] = [];
	for (const line of source.split("\n")) {
		const trimmed = line.replace(/[ \t]+$/, "");

		const directive = trimmed.match(
			/^<!--\s*(?:subtree|id)\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*-->$/,
		);
		if (directive) {
			ids.push(directive[1]);
			continue;
		}

		const untitled = trimmed.match(
			/^<!--\s*h[2-6]:\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*-->$/,
		);
		if (untitled) {
			ids.push(untitled[1]);
			continue;
		}

		const anchor = trimmed.match(BLOCK_ANCHOR);
		if (anchor) ids.push(anchor[1]);
	}
	return ids;
}

/** Is this element already inside a spliced-in copy of the same range? */
function enclosedBy(el: HTMLElement, signature: string): boolean {
	let cursor = el.parentElement?.closest<HTMLElement>(".forester-range") ?? null;
	while (cursor) {
		if (cursor.getAttribute("data-forester-range") === signature) return true;
		cursor = cursor.parentElement?.closest<HTMLElement>(".forester-range") ?? null;
	}
	return false;
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
