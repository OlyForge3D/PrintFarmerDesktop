import type { ImportPreviewRequest, ImportPreviewResponse } from '@shared/ipc';

/** Paging bounds the wire payload, never the set of folders with policies. */
export async function previewAllImportFolders(
  request: ImportPreviewRequest,
): Promise<ImportPreviewResponse> {
  const first = await window.printFarmer.previewImport(request);
  if (!first.complete || !first.foldersTruncated) return first;
  const folders = [...first.folders];
  const seen = new Set(folders.map((folder) => folder.relativePath));
  let page = first;
  let offset = 0;
  while (page.foldersTruncated) {
    const next = page.nextFolderOffset;
    if (next === undefined || next <= offset) {
      throw new Error(
        'Folder discovery is incomplete. Update the sidecar and retry the scan.',
      );
    }
    offset = next;
    page = await window.printFarmer.previewImport({
      ...request,
      folderOffset: offset,
    });
    if (
      !page.complete ||
      page.foldersTotal !== first.foldersTotal ||
      page.modelCount !== first.modelCount
    ) {
      throw new Error(
        'The source changed during folder discovery. Retry the scan.',
      );
    }
    for (const folder of page.folders) {
      if (seen.has(folder.relativePath)) {
        throw new Error(
          'Folder discovery returned overlapping pages. Retry the scan.',
        );
      }
      seen.add(folder.relativePath);
      folders.push(folder);
    }
  }
  if (
    first.foldersTotal === undefined ||
    folders.length !== first.foldersTotal
  ) {
    throw new Error(
      'Folder discovery returned an incomplete hierarchy. Retry the scan.',
    );
  }
  const result = { ...first, folders, foldersTruncated: false };
  delete result.nextFolderOffset;
  return result;
}
