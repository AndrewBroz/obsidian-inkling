import type Moment from "moment";
import { moment as obsidianMoment } from "obsidian";

/**
 * Obsidian's moment, typed so it can be called: obsidian.d.ts types it as a namespace import (`import * as`),
 * which has no call signature under esModuleInterop.
 */
export const moment = obsidianMoment as unknown as typeof Moment;
