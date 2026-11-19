const {basename,dirname}=require('node:path');

async function revealFile(shell,file,{platform=process.platform,sessionBus=process.env.DBUS_SESSION_BUS_ADDRESS}={}) {
  if(platform!=='linux' || sessionBus) {
    try {
      shell.showItemInFolder(file);
      return {name:basename(file),parentOpened:false};
    } catch { /* File highlighting is optional in some desktop shells. */ }
  }
  const error=await shell.openPath(dirname(file));
  if(error)throw new Error(error);
  return {name:basename(file),parentOpened:true};
}
module.exports={revealFile};
