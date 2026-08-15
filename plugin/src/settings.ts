import { App, PluginSettingTab, Setting } from "obsidian";
import type ForesterPlugin from "./main";

export interface ForesterSettings {
	/** Rewrite `![[x]]` into a Forester transclusion block. */
	transclusionHeaders: boolean;
	/** Prefix subtree titles with `Taxon 1.2. `. */
	numberSubtrees: boolean;
	/** Show the `[slug]` after addressable titles. */
	showSlugs: boolean;
	/** `.block` padding-left in `site/theme/style.css` is 5px per level. */
	indentPerLevel: number;
}

export const DEFAULT_SETTINGS: ForesterSettings = {
	transclusionHeaders: true,
	numberSubtrees: true,
	showSlugs: true,
	indentPerLevel: 5,
};

export class ForesterSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ForesterPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

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
	}
}
