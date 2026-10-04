import { App, PluginSettingTab, Setting } from "obsidian";
import type ForesterPlugin from "./main";
import { DEFAULT_POLICY, checkPolicy, encode, type AddressPolicy } from "./mint";
import { DEFAULT_HYBRID, type HybridOptions } from "./hybrid-types";

export interface ForesterSettings {
  /** Opt-in dialect scope and independent publication allowlist. Empty means private/disabled. */
  hybrid: HybridOptions;
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
  hybrid: { ...DEFAULT_HYBRID, folders: [], publicFolders: [], reservedIds: [] },
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

    containerEl.createEl('h3', {text:'Hybrid Markdown (opt-in)'});
    const lists: Array<[keyof HybridOptions,string,string]> = [
      ['folders','Hybrid folders','One vault-relative folder per line. Empty disables the dialect by default. Use / only to intentionally enable the whole vault. A note can override with forester-mode: true/false.'],
      ['publicFolders','Public folders','Separate from syntax enablement. Default is private. Every file placed in these folders inherits public status; only opt-in files are projected. No automatic upload occurs.'],
      ['reservedIds','Reserved IDs','Additional IDs excluded from automatic generation. Decimal-only six-digit IDs are always reserved; automatic IDs are uppercase six-hex.']
    ];
    for (const [key,name,description] of lists) new Setting(containerEl).setName(name).setDesc(description).addTextArea(input =>
      input.setValue(this.plugin.settings.hybrid[key].join('\n')).onChange(async value => {
        this.plugin.settings.hybrid[key] = value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      })
    );
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

		containerEl.createEl("h3", { text: "Addresses" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Minting policy, which must match the [id] table in tree-md.toml. " +
				"An address that is already written is never minted over.",
		});

		new Setting(containerEl)
			.setName("Alphabet")
			.setDesc("Digits, most significant first. The first one is the padding digit.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_POLICY.alphabet)
					.setValue(this.plugin.settings.address.alphabet)
					.onChange((value) => this.applyPolicy({ alphabet: value })),
			);

		new Setting(containerEl)
			.setName("Width")
			.setDesc("Minimum digits. A number past what they hold simply takes more.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.address.width))
					.onChange((value) => this.applyPolicy({ width: Number(value) })),
			);

		new Setting(containerEl)
			.setName("Prefix")
			.setDesc("Written before the digits. Must leave the result a legal identity.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.address.prefix)
					.onChange((value) => this.applyPolicy({ prefix: value })),
			);

		new Setting(containerEl)
			.setName("Scheme")
			.setDesc(
				"Random, because addresses are minted from more than one place — " +
					"tree-md, this plugin, this plugin on a phone — and two of them " +
					"offline would hand out the same next number.",
			)
			.addDropdown((drop) =>
				drop
					.addOption("random", "Random")
					.addOption("sequential", "Sequential")
					.setValue(this.plugin.settings.address.scheme)
					.onChange((value) =>
						this.applyPolicy({ scheme: value as AddressPolicy["scheme"] }),
					),
			);

		new Setting(containerEl)
			.setName("What it mints")
			.setDesc(
				"Requests: fill in an empty `id:`, a bare `<!-- id -->`, a bare " +
					"`<!-- hN -->`, and any heading a #Heading reference points at, so " +
					"nothing that already had an address gets a different one. Every " +
					"note: also address a note that states nothing, which does move it " +
					"— from the file name to the minted id.",
			)
			.addDropdown((drop) =>
				drop
					.addOption("off", "Off")
					.addOption("requests", "Requests only")
					.addOption("notes", "Every note")
					.setValue(this.plugin.settings.mintOnSave)
					.onChange(async (value) => {
						this.plugin.settings.mintOnSave = value as ForesterSettings["mintOnSave"];
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("When it runs")
			.setDesc(
				"On save wraps Obsidian's save command. Externally leaves saving " +
					"alone and waits for the command to be called.",
			)
			.addDropdown((drop) =>
				drop
					.addOption("save", "On save")
					.addOption("external", "When something else asks")
					.setValue(this.plugin.settings.lintTrigger)
					.onChange(async (value) => {
						this.plugin.settings.lintTrigger = value as ForesterSettings["lintTrigger"];
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.lintTrigger === "external") {
			const how = containerEl.createEl("p", { cls: "setting-item-description" });
			how.appendText("Add ");
			how.createEl("code", { text: "Forester: Lint this note" });
			how.appendText(
				" to Linter → Custom Commands. Linter already runs on save, so " +
					"Ctrl+S lints and then mints, in that order — the addresses are " +
					"written into text Linter has finished with rather than into text " +
					"it is about to rewrite.",
			);
		}

		this.showPolicy(containerEl);
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
