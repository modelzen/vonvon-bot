import { readDoc, readDriveFile, readSheet, type DocRequest, type DriveFileRequest, type SheetRequest } from './documents';
import { readChat, readFile, readMessage, readMessages, searchMessages, type ChatRequest, type FileRequest, type MessageRequest, type MessagesRequest, type SearchRequest } from './messages';
import type { ReadDeps } from './shared';

/**
 * The Bot's own Feishu reads (dm-agent 7.1): its tenant token, never lark-cli, in the Bot process, so a read-only group
 * reads too. The agent tools and, from F2, `vonvon feishu` call these. Each request is plain data and a refusal is a
 * {@link import('./denial').FeishuReadRefused} with the sentence to pass on, so another Bot can read for this one. A
 * result stays under TOOL_RESULT_BYTES and says `cursor` when there is more.
 */
export interface FeishuReader {
  messages(request: MessagesRequest): ReturnType<typeof readMessages>;
  message(request: MessageRequest): ReturnType<typeof readMessage>;
  file(request: FileRequest): ReturnType<typeof readFile>;
  chat(request: ChatRequest): ReturnType<typeof readChat>;
  search(request: SearchRequest): ReturnType<typeof searchMessages>;
  doc(request: DocRequest): ReturnType<typeof readDoc>;
  sheet(request: SheetRequest): ReturnType<typeof readSheet>;
  driveFile(request: DriveFileRequest): ReturnType<typeof readDriveFile>;
}

export function createFeishuReader(deps: ReadDeps): FeishuReader {
  return {
    messages: request => readMessages(deps, request),
    message: request => readMessage(deps, request),
    file: request => readFile(deps, request),
    chat: request => readChat(deps, request),
    search: request => searchMessages(deps, request),
    doc: request => readDoc(deps, request),
    sheet: request => readSheet(deps, request),
    driveFile: request => readDriveFile(deps, request),
  };
}
