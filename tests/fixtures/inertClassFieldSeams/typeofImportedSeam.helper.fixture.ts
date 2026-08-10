// Helper module for typeofImportedSeam.fixture.ts -- exists only so that
// fixture can `typeof` an imported (not same-file) function.
export function importedSeam(id: string): Promise<void> {
  return Promise.resolve(id).then(() => undefined);
}
