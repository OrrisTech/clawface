// Type declaration for qrcode-terminal (no @types package available)
declare module 'qrcode-terminal' {
  interface QRCodeOptions {
    small?: boolean;
  }
  function generate(
    text: string,
    opts?: QRCodeOptions,
    callback?: (qr: string) => void,
  ): void;
  export { generate };
}
