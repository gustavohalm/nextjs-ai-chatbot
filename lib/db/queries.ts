import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ArtifactKind } from "@/components/artifact";
import type { VisibilityType } from "@/components/visibility-selector";
import { ChatSDKError } from "../errors";
import type { AppUsage } from "../usage";
import { generateUUID } from "../utils";
import {
  type Chat,
  chat,
  type DBMessage,
  document,
  message,
  type Suggestion,
  stream,
  suggestion,
  type User,
  user,
  vote,
} from "./schema";
import { generateHashedPassword } from "./utils";

// Optionally, if not using email/pass login, you can
// use the Drizzle adapter for Auth.js / NextAuth
// https://authjs.dev/reference/adapter/drizzle
const isMemoryMode = !process.env.POSTGRES_URL;

type StreamRow = { id: string; chatId: string; createdAt: Date };
type DocumentRow = import("./schema").Document;
type VoteRow = import("./schema").Vote;

// In-memory fallback store (activated when POSTGRES_URL is not set)
const memory = {
  users: [] as User[],
  chats: [] as Chat[],
  messages: [] as DBMessage[],
  votes: [] as VoteRow[],
  documents: [] as DocumentRow[],
  suggestions: [] as Suggestion[],
  streams: [] as StreamRow[],
};

// Only initialize Postgres/Drizzle when a URL is provided
const db = (() => {
  if (isMemoryMode) {
    return null as unknown as ReturnType<typeof drizzle>;
  }
  // biome-ignore lint: Forbidden non-null assertion.
  const client = postgres(process.env.POSTGRES_URL!);
  return drizzle(client);
})();

export async function getUser(email: string): Promise<User[]> {
  if (isMemoryMode) {
    return memory.users.filter((u) => u.email === email);
  }
  try {
    return await db.select().from(user).where(eq(user.email, email));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get user by email"
    );
  }
}

export async function createUser(email: string, password: string) {
  const hashedPassword = generateHashedPassword(password);

  if (isMemoryMode) {
    const newUser: User = {
      // Generate a UUID consistent with schema expectations
      id: generateUUID(),
      email,
      password: hashedPassword,
    };
    memory.users.push(newUser);
    return;
  }

  try {
    return await db.insert(user).values({ email, password: hashedPassword });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to create user");
  }
}

export async function createGuestUser() {
  const email = `guest-${Date.now()}`;
  const password = generateHashedPassword(generateUUID());

  if (isMemoryMode) {
    const newUser: User = {
      id: generateUUID(),
      email,
      password,
    };
    memory.users.push(newUser);
    return [{ id: newUser.id, email: newUser.email }];
  }

  try {
    return await db.insert(user).values({ email, password }).returning({
      id: user.id,
      email: user.email,
    });
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create guest user"
    );
  }
}

export async function saveChat({
  id,
  userId,
  title,
  visibility,
}: {
  id: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
}) {
  if (isMemoryMode) {
    const newChat: Chat = {
      id,
      createdAt: new Date(),
      userId,
      title,
      visibility,
      lastContext: null,
    };
    memory.chats.push(newChat);
    return;
  }
  try {
    return await db.insert(chat).values({
      id,
      createdAt: new Date(),
      userId,
      title,
      visibility,
    });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save chat");
  }
}

export async function deleteChatById({ id }: { id: string }) {
  if (isMemoryMode) {
    memory.votes = memory.votes.filter((v) => v.chatId !== id);
    memory.messages = memory.messages.filter((m) => m.chatId !== id);
    memory.streams = memory.streams.filter((s) => s.chatId !== id);
    const index = memory.chats.findIndex((c) => c.id === id);
    if (index >= 0) {
      const [deleted] = memory.chats.splice(index, 1);
      return deleted;
    }
    return undefined;
  }
  try {
    await db.delete(vote).where(eq(vote.chatId, id));
    await db.delete(message).where(eq(message.chatId, id));
    await db.delete(stream).where(eq(stream.chatId, id));

    const [chatsDeleted] = await db
      .delete(chat)
      .where(eq(chat.id, id))
      .returning();
    return chatsDeleted;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete chat by id"
    );
  }
}

export async function deleteAllChatsByUserId({ userId }: { userId: string }) {
  if (isMemoryMode) {
    const userChatIds = memory.chats.filter((c) => c.userId === userId).map((c) => c.id);
    if (userChatIds.length === 0) {
      return { deletedCount: 0 };
    }
    memory.votes = memory.votes.filter((v) => !userChatIds.includes(v.chatId));
    memory.messages = memory.messages.filter((m) => !userChatIds.includes(m.chatId));
    memory.streams = memory.streams.filter((s) => !userChatIds.includes(s.chatId));
    const before = memory.chats.length;
    memory.chats = memory.chats.filter((c) => c.userId !== userId);
    return { deletedCount: before - memory.chats.length };
  }
  try {
    const userChats = await db
      .select({ id: chat.id })
      .from(chat)
      .where(eq(chat.userId, userId));

    if (userChats.length === 0) {
      return { deletedCount: 0 };
    }

    const chatIds = userChats.map((c) => c.id);

    await db.delete(vote).where(inArray(vote.chatId, chatIds));
    await db.delete(message).where(inArray(message.chatId, chatIds));
    await db.delete(stream).where(inArray(stream.chatId, chatIds));

    const deletedChats = await db
      .delete(chat)
      .where(eq(chat.userId, userId))
      .returning();

    return { deletedCount: deletedChats.length };
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete all chats by user id"
    );
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  if (isMemoryMode) {
    const extendedLimit = limit + 1;
    const sorted = memory.chats
      .filter((c) => c.userId === id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    let filteredChats: Chat[] = [];

    if (startingAfter) {
      const selectedChat = memory.chats.find((c) => c.id === startingAfter);
      if (!selectedChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${startingAfter} not found`
        );
      }
      filteredChats = sorted.filter((c) => c.createdAt > selectedChat.createdAt).slice(0, extendedLimit);
    } else if (endingBefore) {
      const selectedChat = memory.chats.find((c) => c.id === endingBefore);
      if (!selectedChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${endingBefore} not found`
        );
      }
      filteredChats = sorted.filter((c) => c.createdAt < selectedChat.createdAt).slice(0, extendedLimit);
    } else {
      filteredChats = sorted.slice(0, extendedLimit);
    }

    const hasMore = filteredChats.length > limit;
    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  }
  try {
    const extendedLimit = limit + 1;

    const query = (whereCondition?: SQL<any>) =>
      db
        .select()
        .from(chat)
        .where(
          whereCondition
            ? and(whereCondition, eq(chat.userId, id))
            : eq(chat.userId, id)
        )
        .orderBy(desc(chat.createdAt))
        .limit(extendedLimit);

    let filteredChats: Chat[] = [];

    if (startingAfter) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, startingAfter))
        .limit(1);

      if (!selectedChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${startingAfter} not found`
        );
      }

      filteredChats = await query(gt(chat.createdAt, selectedChat.createdAt));
    } else if (endingBefore) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, endingBefore))
        .limit(1);

      if (!selectedChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${endingBefore} not found`
        );
      }

      filteredChats = await query(lt(chat.createdAt, selectedChat.createdAt));
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;

    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get chats by user id"
    );
  }
}

export async function getChatById({ id }: { id: string }) {
  if (isMemoryMode) {
    const selectedChat = memory.chats.find((c) => c.id === id);
    return selectedChat ?? null;
  }
  try {
    const [selectedChat] = await db.select().from(chat).where(eq(chat.id, id));
    if (!selectedChat) {
      return null;
    }

    return selectedChat;
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to get chat by id");
  }
}

export async function saveMessages({ messages }: { messages: DBMessage[] }) {
  if (isMemoryMode) {
    for (const msg of messages) {
      memory.messages.push({ ...msg });
    }
    return;
  }
  try {
    return await db.insert(message).values(messages);
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save messages");
  }
}

export async function getMessagesByChatId({ id }: { id: string }) {
  if (isMemoryMode) {
    return memory.messages
      .filter((m) => m.chatId === id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  try {
    return await db
      .select()
      .from(message)
      .where(eq(message.chatId, id))
      .orderBy(asc(message.createdAt));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get messages by chat id"
    );
  }
}

export async function voteMessage({
  chatId,
  messageId,
  type,
}: {
  chatId: string;
  messageId: string;
  type: "up" | "down";
}) {
  if (isMemoryMode) {
    const existing = memory.votes.find((v) => v.messageId === messageId && v.chatId === chatId);
    if (existing) {
      existing.isUpvoted = type === "up";
      return;
    }
    memory.votes.push({
      chatId,
      messageId,
      isUpvoted: type === "up",
    } as VoteRow);
    return;
  }
  try {
    const [existingVote] = await db
      .select()
      .from(vote)
      .where(and(eq(vote.messageId, messageId)));

    if (existingVote) {
      return await db
        .update(vote)
        .set({ isUpvoted: type === "up" })
        .where(and(eq(vote.messageId, messageId), eq(vote.chatId, chatId)));
    }
    return await db.insert(vote).values({
      chatId,
      messageId,
      isUpvoted: type === "up",
    });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to vote message");
  }
}

export async function getVotesByChatId({ id }: { id: string }) {
  if (isMemoryMode) {
    return memory.votes.filter((v) => v.chatId === id);
  }
  try {
    return await db.select().from(vote).where(eq(vote.chatId, id));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get votes by chat id"
    );
  }
}

export async function saveDocument({
  id,
  title,
  kind,
  content,
  userId,
}: {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
}) {
  if (isMemoryMode) {
    const row: DocumentRow = {
      id,
      title,
      kind,
      content,
      userId,
      createdAt: new Date(),
    } as unknown as DocumentRow;
    memory.documents.push(row);
    return [row];
  }
  try {
    return await db
      .insert(document)
      .values({
        id,
        title,
        kind,
        content,
        userId,
        createdAt: new Date(),
      })
      .returning();
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save document");
  }
}

export async function getDocumentsById({ id }: { id: string }) {
  if (isMemoryMode) {
    return memory.documents
      .filter((d) => d.id === id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  try {
    const documents = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(asc(document.createdAt));

    return documents;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get documents by id"
    );
  }
}

export async function getDocumentById({ id }: { id: string }) {
  if (isMemoryMode) {
    const selected = memory.documents
      .filter((d) => d.id === id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return selected ?? undefined;
  }
  try {
    const [selectedDocument] = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt));

    return selectedDocument;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get document by id"
    );
  }
}

export async function deleteDocumentsByIdAfterTimestamp({
  id,
  timestamp,
}: {
  id: string;
  timestamp: Date;
}) {
  if (isMemoryMode) {
    memory.suggestions = memory.suggestions.filter(
      (s) => !(s.documentId === id && s.documentCreatedAt > timestamp),
    );
    const before = memory.documents.length;
    const deleted: DocumentRow[] = [];
    memory.documents = memory.documents.filter((d) => {
      const shouldDelete = d.id === id && d.createdAt > timestamp;
      if (shouldDelete) deleted.push(d);
      return !shouldDelete;
    });
    void before; // satisfy linter for unused variable
    return deleted;
  }
  try {
    await db
      .delete(suggestion)
      .where(
        and(
          eq(suggestion.documentId, id),
          gt(suggestion.documentCreatedAt, timestamp)
        )
      );

    return await db
      .delete(document)
      .where(and(eq(document.id, id), gt(document.createdAt, timestamp)))
      .returning();
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete documents by id after timestamp"
    );
  }
}

export async function saveSuggestions({
  suggestions,
}: {
  suggestions: Suggestion[];
}) {
  if (isMemoryMode) {
    for (const s of suggestions) {
      memory.suggestions.push({ ...s });
    }
    return;
  }
  try {
    return await db.insert(suggestion).values(suggestions);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to save suggestions"
    );
  }
}

export async function getSuggestionsByDocumentId({
  documentId,
}: {
  documentId: string;
}) {
  if (isMemoryMode) {
    return memory.suggestions.filter((s) => s.documentId === documentId);
  }
  try {
    return await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.documentId, documentId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get suggestions by document id"
    );
  }
}

export async function getMessageById({ id }: { id: string }) {
  if (isMemoryMode) {
    return memory.messages.filter((m) => m.id === id);
  }
  try {
    return await db.select().from(message).where(eq(message.id, id));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get message by id"
    );
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  if (isMemoryMode) {
    const toDelete = memory.messages
      .filter((m) => m.chatId === chatId && m.createdAt >= timestamp)
      .map((m) => m.id);
    if (toDelete.length > 0) {
      memory.votes = memory.votes.filter(
        (v) => !(v.chatId === chatId && toDelete.includes(v.messageId)),
      );
      memory.messages = memory.messages.filter(
        (m) => !(m.chatId === chatId && toDelete.includes(m.id)),
      );
    }
    return;
  }
  try {
    const messagesToDelete = await db
      .select({ id: message.id })
      .from(message)
      .where(
        and(eq(message.chatId, chatId), gte(message.createdAt, timestamp))
      );

    const messageIds = messagesToDelete.map(
      (currentMessage) => currentMessage.id
    );

    if (messageIds.length > 0) {
      await db
        .delete(vote)
        .where(
          and(eq(vote.chatId, chatId), inArray(vote.messageId, messageIds))
        );

      return await db
        .delete(message)
        .where(
          and(eq(message.chatId, chatId), inArray(message.id, messageIds))
        );
    }
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete messages by chat id after timestamp"
    );
  }
}

export async function updateChatVisibilityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: "private" | "public";
}) {
  if (isMemoryMode) {
    const target = memory.chats.find((c) => c.id === chatId);
    if (target) {
      target.visibility = visibility;
    }
    return;
  }
  try {
    return await db.update(chat).set({ visibility }).where(eq(chat.id, chatId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to update chat visibility by id"
    );
  }
}

export async function updateChatLastContextById({
  chatId,
  context,
}: {
  chatId: string;
  // Store merged server-enriched usage object
  context: AppUsage;
}) {
  if (isMemoryMode) {
    const target = memory.chats.find((c) => c.id === chatId);
    if (target) {
      // Store merged server-enriched usage object
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      target.lastContext = context as any;
    }
    return;
  }
  try {
    return await db
      .update(chat)
      .set({ lastContext: context })
      .where(eq(chat.id, chatId));
  } catch (error) {
    console.warn("Failed to update lastContext for chat", chatId, error);
    return;
  }
}

export async function getMessageCountByUserId({
  id,
  differenceInHours,
}: {
  id: string;
  differenceInHours: number;
}) {
  if (isMemoryMode) {
    const since = new Date(Date.now() - differenceInHours * 60 * 60 * 1000);
    let countTotal = 0;
    for (const m of memory.messages) {
      if (m.role !== "user") continue;
      const parent = memory.chats.find((c) => c.id === m.chatId);
      if (!parent) continue;
      if (parent.userId !== id) continue;
      if (m.createdAt >= since) countTotal += 1;
    }
    return countTotal;
  }
  try {
    const twentyFourHoursAgo = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    );

    const [stats] = await db
      .select({ count: count(message.id) })
      .from(message)
      .innerJoin(chat, eq(message.chatId, chat.id))
      .where(
        and(
          eq(chat.userId, id),
          gte(message.createdAt, twentyFourHoursAgo),
          eq(message.role, "user")
        )
      )
      .execute();

    return stats?.count ?? 0;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get message count by user id"
    );
  }
}

export async function createStreamId({
  streamId,
  chatId,
}: {
  streamId: string;
  chatId: string;
}) {
  if (isMemoryMode) {
    memory.streams.push({ id: streamId, chatId, createdAt: new Date() });
    return;
  }
  try {
    await db
      .insert(stream)
      .values({ id: streamId, chatId, createdAt: new Date() });
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create stream id"
    );
  }
}

export async function getStreamIdsByChatId({ chatId }: { chatId: string }) {
  if (isMemoryMode) {
    return memory.streams
      .filter((s) => s.chatId === chatId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((s) => s.id);
  }
  try {
    const streamIds = await db
      .select({ id: stream.id })
      .from(stream)
      .where(eq(stream.chatId, chatId))
      .orderBy(asc(stream.createdAt))
      .execute();

    return streamIds.map(({ id }) => id);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get stream ids by chat id"
    );
  }
}
