import type { PublicUser } from './types';

export type ChatState = 'open' | 'cleaned' | 'closed';

export interface ChatMessage {
  id: string;
  author: PublicUser | null;     // null = the author's account was deleted
  isOrganizer: boolean;          // author is the event's organizer
  body: string;                  // '' when deleted
  createdAt: string;             // ISO
  deleted: null | 'author' | 'moderator';
  mine: boolean;                 // viewer wrote it
  canDelete: boolean;            // viewer may delete it now (own message, or viewer is admin; never when already deleted)
}

export interface ChatPage {
  messages: ChatMessage[];       // oldest first; with ?since, only messages created or deleted since the cursor
  cursor: string;                // opaque; send back as ?since=
  state: ChatState;
  canPost: boolean;              // viewer is a participant and state !== 'closed'
  closesAt: string | null;       // ISO; null while the event is open
}
