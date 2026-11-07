export const RELEASE_REPOSITORY='hugo3301/Assistant_BOB';
export function verifyRelease({repository,sha,head,main,runs}){
 if(repository!==RELEASE_REPOSITORY)throw Error('Deployment repository is not authorized');
 if(!/^[a-f0-9]{40}$/.test(sha??'')||head!==sha||main!==sha)throw Error('Deploy only the current immutable main commit');
 const run=runs.find(run=>run.head_sha===sha&&run.head_branch==='main'&&run.head_repository?.full_name===repository&&run.event==='push'&&run.conclusion==='success');
 if(!run)throw Error('No successful push CI for this exact commit');
 return run;
}
