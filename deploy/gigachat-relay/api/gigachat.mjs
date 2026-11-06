import {createGigaBridge} from '../src/gigachat-bridge.mjs';
import ca from '../src/gigachat-root.mjs';
let bridge;
export default {async fetch(request){try{bridge??=createGigaBridge({secret:process.env.GIGACHAT_RELAY_SECRET,authKey:process.env.GIGACHAT_AUTH_KEY,ca});return await bridge(request);}catch{return Response.json({code:'BRIDGE_CONFIG'},{status:503,headers:{'Cache-Control':'no-store'}});}}};
