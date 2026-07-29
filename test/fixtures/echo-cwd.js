// Test fixture: replies with the process's own cwd, so a test can assert
// PARAGON spawned it in an isolated runtime directory rather than
// PARAGON's own checkout or any client-supplied path.
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(process.cwd());
  process.exit(0);
});
