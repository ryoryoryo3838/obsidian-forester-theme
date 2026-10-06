import { App, PluginSettingTab, Setting } from "obsidian";
import type ForesterPlugin from "./main";
import { DEFAULT_POLICY, checkPolicy, encode, type AddressPolicy } from "./mint";
import { DEFAULT_HYBRID, type HybridOptions } from "./hybrid-types";

export interface ForesterSettings {
  /** Markdown exclusion scope and independent publication allowlist; private by default. */
  hybrid: HybridOptions;
  /** Typing `[[` in an enabled note suggests trees and inserts a tree link instead of a file link. */
  treeLinkSuggest: boolean;
	/** Rewrite `![[x]]` into a Forester transclusion block. */
	transclusionHeaders: boolean;
	/** Prefix subtree titles with `Taxon 1.2. `. */
	numberSubtrees: boolean;
	/** Show the `[slug]` after addressable titles. */
	showSlugs: boolean;
	/** `.block` padding-left in `site/theme/style.css` is 5px per level. */
	indentPerLevel: number;
	/**
	 * A copy of `tree-md.toml`'s `[id]` table. It is a copy because that file
	 * lives in the forest repository, which a phone does not have — but the two
	 * have to say the same thing, or the same note gets two different addresses
	 * depending on which tool reached it first.
	 */
	address: AddressPolicy;
	/**
	 * When saving mints. `requests` is tree-md's own rule — an address is minted
	 * only where one is asked for — so turning it on moves no existing address.
	 * `notes` goes further and addresses every note, which is a real change: a
	 * note that states nothing is addressed by its file name, and giving it an
	 * `id` moves the address the published site uses.
	 */
	mintOnSave: "off" | "requests" | "notes";
	/**
	 * Who decides when the pass runs. `save` wraps the save command directly.
	 * `external` leaves it alone and waits to be called — by the Linter plugin's
	 * custom commands, say — so that two things are not rewriting one file at
	 * once, and so the order is the author's to choose.
	 */
	lintTrigger: "save" | "external";
}

export const DEFAULT_SETTINGS: ForesterSettings = {
  hybrid: { ...DEFAULT_HYBRID, folders: [], excludedFolders: [], publicFolders: [], reservedIds: [] },
  treeLinkSuggest: true,
	transclusionHeaders: true,
	numberSubtrees: true,
	showSlugs: true,
	indentPerLevel: 5,
	address: DEFAULT_POLICY,
	mintOnSave: "off",
	lintTrigger: "save",
};

export class ForesterSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ForesterPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

    containerEl.createEl('h3', {text:'Hybrid Markdown'});
    const lists: Array<[keyof HybridOptions,string,string]> = [
      ['excludedFolders','Excluded folders','All Markdown notes use Forester trees by default. One vault-relative folder per line to leave entirely native: no plugin formatting or writes. Legacy folders and forester-mode do not change syntax scope.'],
      ['publicFolders','Public folders','Separate from syntax enablement. Default is private. Every enabled file placed in these folders inherits public status. Exclusions do not grant publication permission. No automatic upload occurs.'],
      ['reservedIds','Reserved IDs','Additional IDs excluded from automatic generation. Decimal-only six-digit IDs are always reserved; automatic IDs are uppercase six-hex.']
    ];
    for (const [key,name,description] of lists) new Setting(containerEl).setName(name).setDesc(description).addTextArea(input =>
      input.setValue((this.plugin.settings.hybrid[key] ?? []).join('\n')).onChange(async value => {
        this.plugin.settings.hybrid[key] = value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl)
      .setName('Suggest trees for [[')
      .setDesc('In notes that use Forester trees, typing [[ (or ![[) lists trees by ID, title or file path and inserts the same link as “Insert tree link” (or “Insert tree embed”). Typing |, # or ^ returns to Obsidian’s own link suggestions. Turn off to always use Obsidian’s file suggestions.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.treeLinkSuggest).onChange(async value => {
        this.plugin.settings.treeLinkSuggest = value;
        await this.plugin.saveSettings();
      }));
    containerEl.createEl('p',{cls:'setting-item-description',text:'Use “Check hybrid trees” for local diagnostics and “Preview public projection” to validate the public subset. Raw Forester is highlighted, not executed. Citation fields: citation-authors and publication-year.'});

		new Setting(containerEl)
			.setName("Transclusion headers")
			.setDesc("Render ![[note]] as a Forester block with taxon, number, slug and metadata.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.transclusionHeaders).onChange(async (value) => {
					this.plugin.settings.transclusionHeaders = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Number subtrees")
			.setDesc("Prefix headings and transclusions with Forester's 1.1-style numbering.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.numberSubtrees).onChange(async (value) => {
					this.plugin.settings.numberSubtrees = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Show slugs")
			.setDesc("Show the [tree-id] after addressable titles, as the site does.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showSlugs).onChange(async (value) => {
					this.plugin.settings.showSlugs = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Indent per level")
			.setDesc("Pixels of left padding per nesting level. The site uses 5.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 24, 1)
					.setValue(this.plugin.settings.indentPerLevel)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.indentPerLevel = value;
						await this.plugin.saveSettings();
					}),
			);

    containerEl.createEl('h3', { text: 'Tree addresses' });
    containerEl.createEl('p', { cls: 'setting-item-description', text: 'H2–H6 headings receive stable IDs after typing settles. Root IDs are minted only when required, or by “Mint address for this note”. Automatic IDs are uppercase, nondecimal six-hex IDs in 111111..FFFFFF. Existing manual IDs are retained. Use Reserved IDs above to protect additional names; legacy address policies do not affect Hybrid Markdown.' });
	}

	/** Take the change only if the policy it produces could not mint an illegal id. */
	private async applyPolicy(change: Partial<AddressPolicy>): Promise<void> {
		const candidate = { ...this.plugin.settings.address, ...change };
		if (checkPolicy(candidate) !== null) return;
		this.plugin.settings.address = candidate;
		await this.plugin.saveSettings();
		this.display();
	}

	private showPolicy(containerEl: HTMLElement): void {
		const policy = this.plugin.settings.address;
		const problem = checkPolicy(policy);
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: problem
				? `Not usable: ${problem}`
				: `Addresses look like ${encode(0, policy)}, ${encode(182, policy)}, ${encode(269, policy)}.`,
		});
	}
}
