import type { HybridResolution, HybridTree } from './hybrid-types';
import { renderMetadata } from './hybrid-header';

export interface BackmatterGroups {
  references: HybridTree[];
  backlinks: HybridTree[];
  related: HybridTree[];
}
export interface BackmatterHost {
  resolve(target: string, path: string): HybridResolution;
  open(target: string, path: string): void;
  openTree(tree: HybridTree, newLeaf: boolean): void | Promise<void>;
  renderBody(el: HTMLElement, tree: HybridTree): void | (() => void);
  reportError?(error: unknown): void;
}

/** Append an owned footer; leave the note and native renderer DOM untouched. */
export function renderBackmatter(container: HTMLElement, groups: BackmatterGroups, host: BackmatterHost): () => void {
  const dom = container.ownerDocument;
  const cleanups: (() => void)[] = [];
  let alive = true;
  const report = (error: unknown) => {
    if (!alive) return;
    try { host.reportError?.(error); } catch { /* Error reporting must not break teardown/events. */ }
  };
  const safely = (action: () => void | Promise<void>) => {
    if (!alive) return;
    try { Promise.resolve(action()).catch(report); } catch (error) { report(error); }
  };
  const dispose = (cleanup: () => void) => {
    try { cleanup(); } catch (error) { report(error); }
  };
  const footer = dom.createElement('footer');
  footer.className = 'hybrid-backmatter';
  footer.setAttribute('data-hybrid-backmatter', '');
  for (const [key, title] of [['references', 'References'], ['backlinks', 'Backlinks'], ['related', 'Related']] as const) {
    if (!groups[key].length) continue;
    const section = dom.createElement('section');
    section.className = 'hybrid-backmatter-group';
    section.setAttribute('data-hybrid-backmatter-group', key);
    const heading = dom.createElement('h2');
    heading.textContent = title;
    section.append(heading);
    for (const tree of groups[key]) {
      const details = dom.createElement('details');
      details.className = 'hybrid-backmatter-item';
      if (tree.meta.taxon) details.setAttribute('data-taxon', tree.meta.taxon);
      const summary = dom.createElement('summary');
      if (tree.meta.taxon) {
        const taxon = dom.createElement('span');
        taxon.className = 'hybrid-taxon-number';
        taxon.textContent = tree.meta.taxon + ' ';
        summary.append(taxon);
      }
      const title = dom.createElement('span');
      title.className = 'hybrid-backmatter-title';
      title.textContent = tree.meta.title;
      summary.append(title);
      if (tree.id) {
        const slug = dom.createElement('a');
        slug.className = 'hybrid-slug';
        slug.textContent = `[${tree.id}]`;
        slug.setAttribute('href', tree.level === 1 ? tree.path : `${tree.path}#^${tree.id}`);
        const click = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          safely(() => host.openTree(tree, Boolean(event.ctrlKey || event.metaKey)));
        };
        slug.addEventListener('click', click);
        cleanups.push(() => slug.removeEventListener('click', click));
        summary.append(dom.createTextNode(' '), slug);
      }
      details.append(summary);
      const metadata = renderMetadata(dom, tree, {
        resolve: (target, path) => {
          try { return host.resolve(target, path); }
          catch (error) { report(error); return { status: 'missing', message: 'Metadata target unavailable.' }; }
        },
        open: (target, path) => safely(() => host.open(target, path)),
        register: cleanup => cleanups.push(cleanup),
      });
      if (metadata) summary.append(metadata);
      let rendered = false;
      const toggle = () => {
        if (!alive || !details.open || rendered) return;
        rendered = true;
        const body = dom.createElement('div');
        body.className = 'hybrid-backmatter-body';
        details.append(body);
        try {
          const cleanup = host.renderBody(body, tree);
          if (cleanup) {
            if (alive) cleanups.push(cleanup);
            else dispose(cleanup);
          }
        } catch (error) {
          if (!alive) return;
          body.textContent = 'Unable to render this tree.';
          body.classList.add('hybrid-backmatter-error');
          body.setAttribute('role', 'alert');
          report(error);
        }
      };
      details.addEventListener('toggle', toggle);
      cleanups.push(() => details.removeEventListener('toggle', toggle));
      section.append(details);
    }
    footer.append(section);
  }
  if (footer.childElementCount) container.append(footer);
  return () => {
    if (!alive) return;
    alive = false;
    for (const cleanup of cleanups.splice(0)) dispose(cleanup);
    footer.remove();
  };
}
