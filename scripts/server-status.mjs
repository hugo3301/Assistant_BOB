const base = process.argv[2];
if (!/^https:\/\/assistant-bob-alpha\.[a-z0-9-]+\.workers\.dev$/.test(base ?? '')) throw Error('Supply production URL');
const response = await fetch(`${base}/admin/status`,{headers:{Authorization:`Bearer ${process.env.ADMIN_SECRET}`},signal:AbortSignal.timeout(20000)});
if (!response.ok) throw Error(`Status failed: ${response.status}`);
console.log(JSON.stringify(await response.json(),null,2));
