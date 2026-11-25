const reportFile = /\.(?:md|txt|json|csv|rst|ya?ml|toml|png|jpe?g|gif|webp|pdf)$/iu;

export function isReportFilePath(path) {
  return typeof path === 'string' && path.length <= 480 && !/[\\:#?\u0000-\u001f\u007f]/u.test(path) && reportFile.test(path) &&
    path.split('/').every(part => part && !part.startsWith('.') && part.trim() === part);
}

// Shared by the renderer and the command router. The native file opener also
// verifies real paths and rejects symlinks before handing a file to the OS.
export function reportLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u0020\u007f]/u.test(value)) return;
  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      if (!url.username && !url.password && url.hostname) return { url: url.href };
    } catch { return; }
    return;
  }
  try {
    const path = decodeURIComponent(value.split('#', 1)[0]).replace(/^\.\//u, '');
    if (isReportFilePath(path)) return { path };
  } catch { return; }
}
