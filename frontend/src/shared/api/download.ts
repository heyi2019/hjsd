/** Blob → 触发浏览器下载。
 *
 *  objectURL 三连（createObjectURL → a.click → revokeObjectURL）此前在
 *  报表 / 附件 / 导入工作台各自复制了一份，收敛到此处统一使用。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
