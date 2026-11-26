export const CHAT_MESSAGE_MAX = 500;
export const CHAT_PAGE_SIZE = 40;

export type ChatMessage = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
};

export type ChatFeed = {
  messages: ChatMessage[];
  viewer: string;
  nextBefore: string | null;
};
