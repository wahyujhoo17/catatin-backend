export interface ToolConfirmationAssessment {
  needsRequiredToolRetry: boolean;
  safeText: string;
}

export const TOOL_CONFIRMATION_FAILURE_MESSAGE =
  "Maaf, saya belum berhasil menyiapkan aksi yang dapat dikonfirmasi. Silakan coba lagi.";
export const REQUIRED_TOOL_INSTRUCTION =
  "PERBAIKAN WAJIB: Permintaan terakhir adalah aksi tulis. Panggil tepat satu tool yang sesuai dengan parameter lengkap. Jangan mengklaim aksi siap, berhasil, atau dapat dikonfirmasi melalui teks biasa.";

export function assessToolConfirmation(input: {
  actionMode: boolean;
  toolCallCount: number;
  modelText: string;
}): ToolConfirmationAssessment {
  if (input.actionMode && input.toolCallCount === 0) {
    return {
      needsRequiredToolRetry: true,
      safeText: TOOL_CONFIRMATION_FAILURE_MESSAGE,
    };
  }

  return {
    needsRequiredToolRetry: false,
    safeText: input.modelText,
  };
}
