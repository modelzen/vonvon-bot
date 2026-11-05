import { callApi, type ApiRequest, type ApiResult } from './api';
import { readBase, type BaseRequest } from './base';
import { readBoard, readMindnote, readMinutes, readSlides, type BoardRequest, type MindnoteRequest, type MinutesRequest, type SlidesRequest } from './canvases';
import { readComments, readDocMedia, readFolder, readWiki, type CommentsRequest, type DocMediaRequest, type FolderRequest, type WikiRequest } from './drive';
import { editDoc, readDoc, readDriveFile, readSheet, type DocEditRequest, type DocEditResult, type DocRequest, type DriveFileRequest, type SheetRequest } from './documents';
import { readChat, readFile, readMessage, readMessages, searchMessages, type ChatRequest, type FileRequest, type MessageRequest, type MessagesRequest, type SearchRequest } from './messages';
import type { ReadDeps } from './shared';

/**
 * The Bot's own Feishu reads and its document edit (dm-agent 7.1): its tenant token, never lark-cli, in the Bot process, so a read-only group
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
  base(request: BaseRequest): ReturnType<typeof readBase>;
  slides(request: SlidesRequest): ReturnType<typeof readSlides>;
  mindnote(request: MindnoteRequest): ReturnType<typeof readMindnote>;
  board(request: BoardRequest): ReturnType<typeof readBoard>;
  minutes(request: MinutesRequest): ReturnType<typeof readMinutes>;
  driveFile(request: DriveFileRequest): ReturnType<typeof readDriveFile>;
  folder(request: FolderRequest): ReturnType<typeof readFolder>;
  wiki(request: WikiRequest): ReturnType<typeof readWiki>;
  comments(request: CommentsRequest): ReturnType<typeof readComments>;
  docMedia(request: DocMediaRequest): ReturnType<typeof readDocMedia>;
  /** The one write here (dm-agent 7.1, F3): `beforeWrite` runs right before Feishu is asked to change the document. */
  docEdit(request: DocEditRequest, beforeWrite?: () => void): Promise<DocEditResult>;
  /** Any Feishu API, on a private chat's turn only (dm-agent 7.6, F7): `beforeSend` runs right before it is called. */
  api(request: ApiRequest, beforeSend?: () => void): Promise<ApiResult>;
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
    base: request => readBase(deps, request),
    slides: request => readSlides(deps, request),
    mindnote: request => readMindnote(deps, request),
    board: request => readBoard(deps, request),
    minutes: request => readMinutes(deps, request),
    driveFile: request => readDriveFile(deps, request),
    folder: request => readFolder(deps, request),
    wiki: request => readWiki(deps, request),
    comments: request => readComments(deps, request),
    docMedia: request => readDocMedia(deps, request),
    docEdit: (request, beforeWrite) => editDoc(deps, request, beforeWrite),
    api: (request, beforeSend) => callApi(deps, request, beforeSend),
  };
}
