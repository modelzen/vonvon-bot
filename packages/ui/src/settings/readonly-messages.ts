import {createContext} from 'react';

export type ReadonlyMessage = {reason: string; message: string};

/** Messages already announced by a containing settings surface. Match both
 * fields: sharing a reason must never hide a more specific field warning. */
export const AnnouncedReadonlyMessages = createContext<readonly ReadonlyMessage[]>([]);
export const hasReadonlyMessage = (messages: readonly ReadonlyMessage[], access: ReadonlyMessage) =>
  messages.some(message => message.reason === access.reason && message.message === access.message);

/** The daemon's standard offline response. A binding panel that already
 * explains the stopped Bot can account for this exact message for its children. */
export const OFFLINE_SETTINGS_MESSAGE: ReadonlyMessage = {
  reason: 'owner-offline',
  message: '这个 Bot 没在运行，运行起来后才能改设置',
};
