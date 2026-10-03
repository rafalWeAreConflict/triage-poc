// Chat photo attachments (multimodal AG-UI input).
//
// CopilotKit sends attachments inline as AG-UI image content parts; Pydantic AI's AG-UI
// adapter turns them into image input for the (vision) model, and the Django copilot view
// stores each one in MinIO/S3 as a TicketPhoto (see backend/triage/photos.py). AG-UI replays
// the whole thread on every run, so images are downscaled + re-encoded as JPEG here to keep
// every request small (a phone photo of several MB becomes ~100-300 KB).
import type { AttachmentsConfig } from "@copilotkit/react-core/v2";

/** Longest edge after downscaling (Anthropic's vision models gain nothing above ~1568px). */
export const MAX_IMAGE_EDGE = 1568;
export const JPEG_QUALITY = 0.85;
/** Pre-downscale limit for the picked file. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

type UploadResult = Awaited<ReturnType<NonNullable<AttachmentsConfig["onUpload"]>>>;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function scaledSize(width: number, height: number, maxEdge = MAX_IMAGE_EDGE) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const ratio = maxEdge / longest;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

async function downscaleToJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.fillStyle = "#fff"; // flatten transparency (JPEG has no alpha)
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  } finally {
    bitmap.close();
  }
}

/** `onUpload` handler: downscaled JPEG (base64, inline); falls back to the original bytes. */
export async function prepareImageAttachment(file: File): Promise<UploadResult> {
  if (file.type.startsWith("image/") && file.type !== "image/gif") {
    try {
      return { type: "data", value: await downscaleToJpeg(file), mimeType: "image/jpeg" };
    } catch {
      // fall through: send the original image as-is
    }
  }
  return {
    type: "data",
    value: arrayBufferToBase64(await file.arrayBuffer()),
    mimeType: file.type,
  };
}

export const copilotAttachments: AttachmentsConfig = {
  enabled: true,
  accept: "image/jpeg,image/png,image/webp,image/gif",
  maxSize: MAX_ATTACHMENT_BYTES,
  onUpload: prepareImageAttachment,
};
