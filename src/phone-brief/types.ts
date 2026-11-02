// types.ts — shapes for the Command Hub morning brief (GET /phone/brief).
// Contract: contracts/phone-inbox.openapi.yaml in the MVOS repo (path /phone/brief).

/** Section ids the phone knows, in the order they are sent. */
export const BRIEF_SECTION_IDS = ['accounting', 'contacts', 'newsletters'] as const;
export type BriefSectionId = (typeof BRIEF_SECTION_IDS)[number];

export const MAX_ITEMS_PER_SECTION = 10;
export const MAX_ITEM_TEXT = 280;

export interface BriefItem {
  /** Plain text, at most MAX_ITEM_TEXT characters. Omitted for sender-and-subject-only items. */
  text?: string;
  from?: string;
  subject?: string;
}

export interface BriefSection {
  id: BriefSectionId;
  items: BriefItem[];
}

/** What is stored for a day, and what the route returns apart from the Signal number. */
export interface Brief {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** ISO-8601 with offset. */
  generatedAt: string;
  sections: BriefSection[];
}

/** What the generator hands each source: which local day is being summarised. */
export interface BriefContext {
  /** The brief's own local date (today), YYYY-MM-DD. */
  date: string;
  /** Unix seconds bounding "yesterday" in the brief's timezone: [start, end). */
  yesterday: { start: number; end: number };
}

/** One section's supplier. Other owners (accounting, contacts) register theirs with PhoneBriefService.registerSource. */
export interface BriefSource {
  id: BriefSectionId;
  /** Items for this section; throwing or returning [] simply leaves the section out. */
  items(ctx: BriefContext): Promise<BriefItem[]>;
}

export interface BriefStore {
  save(brief: Brief): Promise<void>;
  /** The stored brief for a local date, or null if the job has not run for it. */
  get(date: string): Promise<Brief | null>;
}
