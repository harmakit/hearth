import { posix, win32 } from 'node:path';

export function runtimePath(environment, platform = process.platform) {
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  const value = windows
    ? Object.entries(environment).find(([name]) => name.toUpperCase() === 'PATH')?.[1]
    : environment.PATH;
  return (value ?? '').split(path.delimiter).map(folder => windows ? folder.replace(/^"(.*)"$/u, '$1') : folder)
    .filter(folder => path.isAbsolute(folder));
}

export function runtimeCandidates(runtime, directories, platform = process.platform) {
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  return directories.map(folder => path.join(folder, windows ? runtime + '.exe' : runtime));
}
