// Test fixture: closes stdin immediately, then exits shortly after — gives
// the parent's large write a chance to land on an already-closed pipe.
process.stdin.destroy();
setTimeout(() => process.exit(1), 20);
