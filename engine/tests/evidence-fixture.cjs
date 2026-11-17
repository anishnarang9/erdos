// Test-only issuer for synthetic signed text jobs. It saves keys in the scratch directory.
const {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,sign}=require('node:crypto');
const {readFileSync,writeFileSync,mkdirSync}=require('node:fs');
const {join}=require('node:path');

const [mode,root,selection='all']=process.argv.slice(2);
const hex=bytes=>'0x'+Buffer.from(bytes).toString('hex');
const sha=bytes=>createHash('sha256').update(bytes).digest();
const b64=bytes=>Buffer.from(bytes).toString('base64url');
const read=name=>JSON.parse(readFileSync(join(root,name)));
const write=(name,value,privateFile=false)=>writeFileSync(join(root,name),JSON.stringify(value,null,2)+'\n',{mode:privateFile?0o600:0o644});

if(mode==='prepare'){
  for(const dir of ['reference','delivery','evidence']) mkdirSync(join(root,dir),{recursive:true});
  writeFileSync(join(root,'delivery/note.txt'),'Signed delivery.\n');
  const profiles=selection==='all'?['ed25519/v1','eip712/v1','jws/Ed25519/v1','jws/EdDSA/v1','jws/ES256/v1','jws/RS256/v1']:[selection];
  const secrets=[];
  const evidence=profiles.map((profile,index)=>{
    let signer,privateKey;
    if(profile==='eip712/v1'){
      const {Wallet}=require('ethers');
      const wallet=new Wallet('0x'+'77'.repeat(32));
      signer=wallet.address.toLowerCase();
      privateKey=wallet.privateKey;
    } else {
      let keys;
      if(profile.includes('ES256')) keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
      else if(profile.includes('RS256')) keys=generateKeyPairSync('rsa',{modulusLength:2048});
      else {
        const seed=Buffer.alloc(32,0x31);
        privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
        keys={privateKey,publicKey:createPublicKey(privateKey)};
      }
      privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
      if(profile.includes('ES256')){
        const jwk=keys.publicKey.export({format:'jwk'});
        signer=hex(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]));
      } else {
        let key=keys.publicKey.export({type:'spki',format:'der'});
        if(!profile.includes('RS256')) key=key.subarray(-32);
        signer=hex(key);
      }
    }
    const name='evidence-'+index+(profile.startsWith('jws/')?'.jws':'.json');
    secrets.push({name,profile,privateKey});
    return {name,profile,signer,parser:'json/v1',fields:[
      {name:'artifactHash',type:'string'},{name:'contextHash',type:'string'},{name:'issuedAt',type:'i64'}
    ],bindings:[{field:'artifactHash',file:'note.txt'}],contextField:'contextHash'};
  });
  write('signers-private.json',secrets,true);
  write('plan.json',{version:1,deliverables:[{name:'note.txt',parser:'text/v1'}],references:[],evidence,
    rules:evidence.map(policy=>({op:'gte',left:{op:'field',source:'evidence',file:policy.name,field:'issuedAt'},
      right:{op:'literal',type:'i64',value:'1794680000'}}))});
} else if(mode==='sign') {
  const manifest=read('package/manifest.json');
  const context=Buffer.concat([Buffer.from([1]),Buffer.from(BigInt(5042002).toString(16).padStart(64,'0'),'hex'),
    Buffer.alloc(20,0x11),Buffer.from(BigInt(9).toString(16).padStart(64,'0'),'hex'),Buffer.alloc(20,0x22),
    Buffer.from(manifest.rulesHash.slice(2),'hex'),Buffer.from(manifest.referenceHash.slice(2),'hex')]);
  write('job.json',{context:hex(context),imageId:manifest.imageId});
  const payload=Buffer.from(JSON.stringify({artifactHash:hex(sha(readFileSync(join(root,'delivery/note.txt')))),
    contextHash:hex(sha(context)),issuedAt:'1794680001'}));
  for(const {name,profile,privateKey} of read('signers-private.json')){
    let envelope;
    if(profile==='eip712/v1'){
      const {Wallet,TypedDataEncoder}=require('ethers');
      const domain={name:'UBC26 Evidence',version:'1',chainId:5042002,verifyingContract:hex(context.subarray(33,53))};
      const types={Evidence:[{name:'contextHash',type:'bytes32'},{name:'payloadHash',type:'bytes32'}]};
      const digest=TypedDataEncoder.hash(domain,types,{contextHash:hex(sha(context)),payloadHash:hex(sha(payload))});
      envelope=JSON.stringify({payload:hex(payload),signature:new Wallet(privateKey).signingKey.sign(digest).serialized});
    } else if(profile==='ed25519/v1'){
      const message=Buffer.concat([Buffer.from('UBC26/evidence/v1'),payload]);
      envelope=JSON.stringify({payload:hex(payload),signature:hex(sign(null,message,privateKey))});
    } else {
      const alg=profile.split('/')[1];
      const input=b64(JSON.stringify({alg}))+'.'+b64(payload);
      const algorithm=alg==='ES256'?'sha256':alg==='RS256'?'RSA-SHA256':null;
      envelope=input+'.'+b64(sign(algorithm,Buffer.from(input),{key:privateKey,dsaEncoding:'ieee-p1363'}));
    }
    writeFileSync(join(root,'evidence',name),envelope);
  }
} else throw Error('Use prepare or sign with a scratch directory');
