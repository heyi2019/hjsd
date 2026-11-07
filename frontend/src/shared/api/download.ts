/** Blob → 触发浏览器下载。
 *
 *  objectURL 三连（createObjectURL → a.click → revokeObjectURL）此前在
 *  各类导出入口统一复用此下载封装，避免重复实现。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
