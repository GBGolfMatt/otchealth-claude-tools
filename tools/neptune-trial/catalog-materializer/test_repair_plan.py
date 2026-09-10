import hashlib,json,unittest
from repair_plan import build_plan,apply_row,MAX_ENTRIES
H=lambda s:hashlib.sha256(s.encode()).hexdigest()
def row(path='a.pdf',**kw):
    r={'path':path,'sha256':H('x'),'sidecar':False,'enriched':False};r.update(kw);return r
def inv(path='a.pdf',size=1):return {path:{'size':size,'etag':'e','last_modified':'t'},'_TEXT/'+path+'.txt':{'size':2,'etag':'te','last_modified':'tt'}}
def plan(rows,inventory=None):return build_plan(rows,inventory if inventory is not None else inv(),'v1',H('source'))
class Tests(unittest.TestCase):
 def test_invalid_source_claims_never_become_automatic_repairs(self):
  for flag in (0,1,'false',None,[],{}):
   r=row(sidecar=flag)
   self.assertEqual(plan([(0,json.dumps(r).encode(),r)])['entries'][0]['action'],'review_sidecar_schema')
  for error in ({},[],{'code':'failed'},['failed'],'failed'):
   r=row(err=error)
   self.assertEqual(plan([(0,json.dumps(r).encode(),r)])['entries'][0]['action'],'review_source_error')
  for source_hash in ('0'*64,'invalid',None):
   r=row(sha256=source_hash)
   self.assertEqual(plan([(0,json.dumps(r).encode(),r)])['entries'],[])
 def test_healthy_catalog_rows_do_not_consume_manifest_limit(self):
  inventory={};rows=[]
  for n in range(MAX_ENTRIES+1):
   path='healthy%d.pdf'%n
   r=row(path,sidecar=True,enriched=True,enriched_sha256=H('x'))
   rows.append((n,json.dumps(r).encode(),r));inventory.update(inv(path))
  missing=row('missing.pdf',sidecar=True,enriched=True,enriched_sha256=H('x'))
  rows.append((len(rows),json.dumps(missing).encode(),missing))
  result=plan(rows,inventory)
  self.assertEqual(len(result['entries']),1)
  self.assertEqual(result['entries'][0]['source_exclusion'],'eligible')
  self.assertEqual(result['entries'][0]['action'],'recover_original')
  self.assertEqual(result['counts']['outside_repair_scope'],MAX_ENTRIES+1)
 def test_restore_preserves_and_framing(self):
  raw=('{"path":"a.pdf","sha256":"%s","sidecar":false,"text_chars":77,"enriched":false}'%H('x')).encode()
  for ending in (b'\n',b'\r\n',b''):
   framed=raw+ending;e=plan([(4,framed,row(text_chars=77))])['entries'][0];out=apply_row(framed,e)
   self.assertEqual(json.loads(out)['text_chars'],77);self.assertTrue(json.loads(out)['sidecar']);self.assertTrue(out.endswith(ending));self.assertEqual(apply_row(out,e),out)
 def test_actions(self):
  cases=[(row(),{},'recover_original'),(row(sidecar='yes'),inv(),'review_sidecar_schema'),(row(err='x'),inv(),'review_source_error'),(row(),{'a.pdf':{'size':0,'etag':'e','last_modified':'t'}},'review_zero_original'),(row(),{'a.pdf':{'size':1,'etag':'e','last_modified':'t'}},'extract_text')]
  for r,i,w in cases:self.assertEqual(plan([(0,b'{}',r)],i)['entries'][0]['action'],w)
  self.assertEqual(plan([(0,b'{}',row(sidecar=True,enriched=False))])['entries'][0]['action'],'enrichment_requires_verified_result')
 def test_duplicate_invalid_bounds_marker(self):
  with self.assertRaisesRegex(ValueError,'duplicate_valid'):plan([(0,b'a',row()),(1,b'b',row())])
  self.assertEqual(plan([(0,b'x',row('../bad'))])['entries'],[])
  inventory={};rows=[]
  for n in range(MAX_ENTRIES+1):rows.append((n,str(n).encode(),row('p%d.pdf'%n)));inventory.update(inv('p%d.pdf'%n))
  with self.assertRaisesRegex(ValueError,'bounded'):plan(rows,inventory)
  i=inv();i['_CATALOG/.enrich-bedrock-batch.json']={'size':1,'etag':'m','last_modified':'t'};self.assertTrue(plan([(0,b'x',row())],i)['existing_batch_marker_present'])
 def test_stale_and_malformed_refused(self):
  raw=('{"path":"a.pdf","sha256":"%s","sidecar":false,"enriched":false}'%H('x')).encode();e=plan([(0,raw,row())])['entries'][0]
  with self.assertRaisesRegex(ValueError,'stale'):apply_row(raw+b' ',e)
  malformed=raw.replace(b'false',b'0');bad=dict(e);bad['raw_line_sha256']=hashlib.sha256(malformed).hexdigest()
  with self.assertRaisesRegex(ValueError,'apply_invalid'):apply_row(malformed,bad)
  with self.assertRaisesRegex(ValueError,'inventory_invalid'):plan([], {1:{'size':1,'etag':'e','last_modified':'t'}})
if __name__=='__main__':unittest.main()
