import {createHttpServer} from '../server/http.mjs';
const server=await createHttpServer({liveReload:true});
server.listen(Number(process.env.PORTAL_PREVIEW_PORT||4177),'127.0.0.1',()=>console.log('110lab preview: http://127.0.0.1:'+server.address().port+' /workbench'));
