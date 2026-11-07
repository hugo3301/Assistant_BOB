// A separate classic script can recover even if the module cannot start.
// Keep as literal browser code: serializing a Worker-bundled function is unsafe.
export const ADMIN_BOOT_GUARD=String.raw`
(function(){
 var failed=false;
 function showFailure(){if(failed||window.__bobAdminSettled)return;failed=true;document.getElementById('content').textContent='';document.getElementById('boot-error').hidden=false;document.getElementById('export').disabled=true;}
 document.getElementById('boot-retry').addEventListener('click',function(){location.reload();});
 window.addEventListener('error',function(event){if(event.target===window)showFailure();});
 window.addEventListener('unhandledrejection',showFailure);
 setTimeout(showFailure,20000);
})();`;
