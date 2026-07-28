// Test fixture: exits immediately without reading stdin, to reliably
// trigger EPIPE when the parent writes a large prompt to this process's
// closed stdin. See orchestrationEpipe.test.js.
process.exit(1);
