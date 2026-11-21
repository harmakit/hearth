#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// Install this launcher as hearth-check-worker on a trusted, dedicated SSH worker host.
// Pull and pin the runtime image on that host before accepting tasks.
const image=process.env.HEARTH_WORKER_IMAGE;
if(!image || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/u.test(image))throw Error('HEARTH_WORKER_IMAGE must be pinned by digest');
const worker=readFileSync(new URL('./isolated-check-worker.mjs',import.meta.url),'utf8');
const docker=spawn('docker',['run','--rm','--interactive','--pull=never','--network=none','--read-only','--user=65534:65534',
  '--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=256m','--cpus=1',
  '--tmpfs=/work:rw,nodev,nosuid,size=64m,mode=1777','--workdir=/work',
  '--entrypoint=/usr/local/bin/node',image,'--input-type=module','--eval',worker],
  {stdio:'inherit',shell:false});
docker.once('error',error=>{console.error(error.message);process.exitCode=1;});
docker.once('close',code=>{process.exitCode=code ?? 1;});
