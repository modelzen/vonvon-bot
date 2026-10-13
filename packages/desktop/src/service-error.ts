const messages = {
  install_refused: 'install_refused: Service installation was refused. Check the service registration before retrying.',
  install_rolled_back: 'install_rolled_back: Service installation failed and was rolled back. Check service status before retrying.',
  install_incomplete: 'install_incomplete: Service installation is incomplete. Check service status and retry service install or uninstall.',
  uninstall_refused: 'uninstall_refused: Service removal was refused. Check the service registration before retrying.',
  uninstall_rolled_back: 'uninstall_rolled_back: Service removal failed and was rolled back. Check service status before retrying.',
  uninstall_incomplete: 'uninstall_incomplete: Service removal is incomplete. The daemon may still be running. Retry service uninstall.',
  unsupported: 'Open at login is unavailable on this platform. Start the application manually.',
  unpackaged: 'Open at login requires the packaged desktop application.',
  distribution: 'The bundled Vonvon daemon is unavailable. Reinstall the desktop application.',
  readback: 'The service registration could not be verified. Check service status before retrying.',
  mismatch: 'The service registration does not match the requested setting. Check service status before retrying.',
  reattach: 'The service was removed, but the desktop could not reconnect. Reopen the desktop application.',
};

export class ServiceActionError extends Error {
  readonly #reason: keyof typeof messages;

  constructor(reason: keyof typeof messages) {
    super(messages[reason]);
    this.#reason = reason;
  }

  get safeMessage(): string { return messages[this.#reason]; }
}
