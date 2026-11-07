import {createGigaBridge} from '../src/gigachat-bridge.mjs';
import {createNetlifyHandler} from '../src/netlify-handler.mjs';
import ca from '../src/gigachat-root.mjs';
let bridge;
export const handler=createNetlifyHandler(async request=>{bridge??=createGigaBridge({secret:process.env.GIGACHAT_RELAY_SECRET,authKey:process.env.GIGACHAT_AUTH_KEY,ca});return bridge(request);});
