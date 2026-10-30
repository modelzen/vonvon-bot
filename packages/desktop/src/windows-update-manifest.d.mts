export interface WindowsUpdateManifest {schemaVersion:1;product:'vonvon-bot';version:string;architecture:'x64'|'arm64';url:string;size:number;sha512:string;notes?:string}
export interface SignedWindowsUpdate {payload:string;signature:string}
export function normalizeWindowsPublicKey(value:unknown):string;
export function publicKeyFromPrivate(value:string):string;
export function validateWindowsUpdatePayload(value:unknown,architecture?:string):WindowsUpdateManifest;
export function signWindowsUpdate(payload:WindowsUpdateManifest,privateKey:string):SignedWindowsUpdate;
export function verifyWindowsUpdate(envelope:unknown,publicKey:string,architecture?:string):WindowsUpdateManifest;
