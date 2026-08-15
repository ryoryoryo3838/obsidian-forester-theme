/**
 * DOM builders that mirror `tree.xsl`'s `f:frontmatter` template:
 *
 *   <header>
 *     <h1><span class="taxon">Note 1.2. </span>Title <a class="slug">[uri]</a></h1>
 *     <div class="metadata"><ul><li class="meta-item">…</li></ul></div>
 *   </header>
 *
 * Class names are kept identical to the published site so that the CSS values
 * in `site/theme/style.css` can be ported across verbatim.
 */

import { formatDate, taxonWithNumber, type NodeMeta } from "./forest";

export interface HeaderOptions {
	taxon?: string;
	/** Full dotted path once the ambient (cross-document) prefix is applied. */
	numberPath: string;
	uri?: string;
	meta: NodeMeta;
	/** Root headers put the taxon on its own line and drop the number. */
	isRoot: boolean;
}

/** `<div class="metadata">` — omitted entirely when there is nothing to show. */
export function buildMetadata(doc: Document, meta: NodeMeta): HTMLElement | null {
	const items: HTMLElement[] = [];

	if (meta.date) {
		const li = doc.createElement("li");
		li.className = "meta-item";
		li.textContent = formatDate(meta.date);
		items.push(li);
	}

	// metadata.xsl: one `<address>` holding the authors, then contributors after
	// " with contributions from ". tree.xsl skips the whole item when the
	// `author` meta is "false".
	const authors = meta.authors ?? [];
	const contributors = meta.contributors ?? [];
	if (!meta.hideAuthors && (authors.length > 0 || contributors.length > 0)) {
		const li = doc.createElement("li");
		li.className = "meta-item";
		const address = doc.createElement("address");
		address.className = "author";
		address.textContent =
			authors.join(", ") +
			(contributors.length > 0
				? " with contributions from " + contributors.join(", ")
				: "");
		li.appendChild(address);
		items.push(li);
	}

	for (const { name, value } of meta.extra ?? []) {
		const li = doc.createElement("li");
		li.className = "meta-item";
		appendMetaValue(doc, li, name, value);
		items.push(li);
	}

	if (items.length === 0) return null;

	const wrapper = doc.createElement("div");
	wrapper.className = "metadata";
	const ul = doc.createElement("ul");
	for (const li of items) ul.appendChild(li);
	wrapper.appendChild(ul);
	return wrapper;
}

/** Port of the per-`meta` templates in `metadata.xsl`. */
function appendMetaValue(
	doc: Document,
	li: HTMLElement,
	name: string,
	value: string,
): void {
	const anchor = (href: string, text: string, className: string): HTMLElement => {
		const a = doc.createElement("a");
		a.className = className;
		a.href = href;
		a.textContent = text;
		a.setAttribute("target", "_blank");
		a.setAttribute("rel", "noopener");
		return a;
	};

	switch (name) {
		case "doi":
			li.appendChild(anchor("https://www.doi.org/" + value, value, "doi link"));
			return;
		case "orcid":
			li.appendChild(anchor("https://orcid.org/" + value, value, "orcid"));
			return;
		case "external":
			li.appendChild(anchor(value, value, "link external"));
			return;
		case "slides":
			li.appendChild(anchor(value, "Slides", "link external"));
			return;
		case "video":
			li.appendChild(anchor(value, "Video", "link external"));
			return;
		default:
			// position / institution / venue / source carry inline markup.
			appendInline(doc, li, value);
	}
}

/**
 * The site renders these fields through the full Forester pipeline. Markdown
 * front matter only ever carries `[label](href)`, so that is all we resolve.
 */
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function appendInline(doc: Document, parent: HTMLElement, text: string): void {
	let last = 0;
	MARKDOWN_LINK.lastIndex = 0;

	for (let m = MARKDOWN_LINK.exec(text); m; m = MARKDOWN_LINK.exec(text)) {
		if (m.index > last) {
			parent.appendChild(doc.createTextNode(text.slice(last, m.index)));
		}
		const a = doc.createElement("a");
		a.className = "link external";
		a.href = m[2];
		a.textContent = m[1];
		a.setAttribute("target", "_blank");
		a.setAttribute("rel", "noopener");
		parent.appendChild(a);
		last = m.index + m[0].length;
	}

	if (last < text.length) {
		parent.appendChild(doc.createTextNode(text.slice(last)));
	}
}

/** `<span class="taxon">` — the bold `Taxon N.M. ` prefix inside the `<h1>`. */
export function buildTaxonSpan(doc: Document, options: HeaderOptions): HTMLElement | null {
	// `tree.xsl` never numbers the root tree of a page.
	const numberPath = options.isRoot ? "" : options.numberPath;
	const text = taxonWithNumber(options.taxon, numberPath);
	if (text.length === 0) return null;

	const span = doc.createElement("span");
	span.className = "taxon";
	span.textContent = text;
	return span;
}

/** `<a class="slug">[uri]</a>`, rendered only for trees that have an address. */
export function buildSlug(doc: Document, uri: string | undefined): HTMLElement | null {
	if (!uri) return null;
	const a = doc.createElement("a");
	a.className = "slug";
	a.textContent = "[" + uri + "]";
	a.setAttribute("data-forester-uri", uri);
	return a;
}

/**
 * A complete transclusion header. Used for `![[x]]` blocks, where we synthesize
 * the whole `<header>` rather than decorating an existing heading element.
 */
export function buildHeader(
	doc: Document,
	title: string,
	options: HeaderOptions,
): HTMLElement {
	const header = doc.createElement("header");
	header.className = "forester-header";

	const h1 = doc.createElement("h1");

	const taxon = buildTaxonSpan(doc, options);
	if (taxon) h1.appendChild(taxon);

	const titleSpan = doc.createElement("span");
	titleSpan.className = "forester-title";
	titleSpan.textContent = title;
	h1.appendChild(titleSpan);

	const slug = buildSlug(doc, options.uri);
	if (slug) {
		h1.appendChild(doc.createTextNode(" "));
		h1.appendChild(slug);
	}

	header.appendChild(h1);

	const metadata = buildMetadata(doc, options.meta);
	if (metadata) header.appendChild(metadata);

	return header;
}
