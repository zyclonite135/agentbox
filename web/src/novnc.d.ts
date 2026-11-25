declare module "*vendor/novnc/core/rfb.js" {
 const RFB: new (target: HTMLElement, url: string, options?: {
  minRemoteWidth?: number; preserveViewportAspect?: () => boolean;
 }) => EventTarget & {
  disconnect(): void; focus(): void; clipboardPasteFrom(text: string): void;
  offerClipboard(provider: () => Promise<string | null>): Promise<boolean>;
  deferInput(ready: Promise<void>): void;
  withdrawClipboardOffer(): void;
  sendKey(keysym: number, code: string, down?: boolean): void;
  scaleViewport: boolean; resizeSession: boolean; qualityLevel: number; compressionLevel: number;
 };
 export default RFB;
}
