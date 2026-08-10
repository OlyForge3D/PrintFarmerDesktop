// A static field lives on the constructor function, not on instances, and is
// unaffected by useDefineForClassFields.
export class Registry {
  static resolveConflict?: (id: string) => Promise<void>;
}
