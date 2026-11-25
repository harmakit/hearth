const { readdirSync } = require('node:fs');
const { delimiter, isAbsolute, join } = require('node:path');

// A desktop launch need not inherit an interactive shell's PATH. In particular,
// Homebrew versioned Node kegs are commonly installed without a global link.
// Keep the owner's explicit PATH and normal system tools ahead of these fallbacks.
function macToolPath(inherited, home, readDirectory = readdirSync) {
  const locations = String(inherited ?? '').split(delimiter).filter(isAbsolute);
  const standard = [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const nodeKegs = [];
  for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
    try {
      const names = readDirectory(prefix).filter(name => /^node(?:@\d{1,3})?$/.test(name));
      names.sort((a, b) => (b === 'node' ? Infinity : Number(b.slice(5))) - (a === 'node' ? Infinity : Number(a.slice(5))));
      nodeKegs.push(...names.map(name => join(prefix, name, 'bin')));
    } catch { /* No readable Homebrew installation at this prefix. */ }
  }
  return [...new Set([...locations, ...standard, ...nodeKegs])].join(delimiter);
}

module.exports = { macToolPath };
