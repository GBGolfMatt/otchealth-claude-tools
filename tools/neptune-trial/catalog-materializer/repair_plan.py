"""Pure bounded planner, no storage or cloud calls.

apply_row is a transformer, never a transaction. A caller must revalidate each metadata
pin and condition the catalog write on its freshly observed ETag before committing.
sidecar=True proves only verified sidecar-object existence, never lineage or OCR quality.
"""
import hashlib,json
from collections import Counter
from materialize import safe_path,SHA,reason
MAX_ENTRIES=5000
EXCLUSIONS={'invalid_path','outside_cohort','missing_source_hash','missing_sidecar_claim','missing_enrichment_claim','missing_matching_enrichment_hash','source_error','invalid_metadata_schema','eligible'}
def sha(b):return hashlib.sha256(b).hexdigest()
def enc(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def meta(v):
 if type(v) is not dict or set(v)!={'size','etag','last_modified'} or type(v['size']) is not int or v['size']<0 or not isinstance(v['etag'],str) or not v['etag'] or not isinstance(v['last_modified'],str) or not v['last_modified']:raise ValueError('inventory_invalid')
 return dict(v)
def action(row,original,text,exclusion):
 if original is None:return 'recover_original'
 if original['size']==0:return 'review_zero_original'
 if 'sidecar' in row and type(row['sidecar']) is not bool:return 'review_sidecar_schema'
 if isinstance(row.get('err'),(dict,list)) or row.get('err'):return 'review_source_error'
 if exclusion=='missing_source_hash':return 'review_source_error'
 if row.get('sidecar') is not True:
  if text is None:return 'extract_text'
  if text['size']==0:return 'review_empty_text'
  return 'restore_sidecar_existence'
 if exclusion in ('missing_enrichment_claim','missing_matching_enrichment_hash','eligible'):return 'enrichment_requires_verified_result'
 return 'review_source_error'
def build_plan(rows,inventory,source_version_id,source_sha256):
 if not isinstance(inventory,dict) or not isinstance(source_version_id,str) or not source_version_id or not isinstance(source_sha256,str) or not SHA.fullmatch(source_sha256):raise ValueError('source_pin_invalid')
 inv={}
 for k,v in inventory.items():
  if not isinstance(k,str):raise ValueError('inventory_invalid')
  inv[k]=meta(v)
 counts=Counter();entries=[];seen=set()
 for line,raw,row in rows:
  if type(line) is not int or line<0 or not isinstance(raw,(bytes,bytearray)) or type(row) is not dict:raise ValueError('row_invalid')
  path=row.get('path')
  if not safe_path(path):counts['invalid_or_internal_path']+=1;continue
  if path in seen:raise ValueError('duplicate_valid_catalog_path')
  seen.add(path); original=inv.get(path);text=inv.get('_TEXT/'+path+'.txt'); exclusion=reason(row,[],True) or 'eligible'
  if exclusion not in EXCLUSIONS:raise ValueError('exclusion_invalid')
  counts['valid_catalog_rows']+=1
  if original is not None and exclusion not in ('missing_sidecar_claim','missing_enrichment_claim'):
   counts['outside_repair_scope']+=1
   continue
  a=action(row,original,text,exclusion);counts[a]+=1
  if len(entries)>=MAX_ENTRIES:raise ValueError('repair_entries_bounded')
  e={'line_index':line,'path':path,'raw_line_sha256':sha(bytes(raw)),'action':a,'source_exclusion':exclusion,'original_metadata':original,'text_metadata':text}
  if a=='restore_sidecar_existence':
   if exclusion!='missing_sidecar_claim' or not isinstance(row.get('sha256'),str) or row['sha256']=='0'*64 or not SHA.fullmatch(row['sha256']):raise ValueError('automatic_action_invalid')
   final=dict(row);final['sidecar']=True;_,ending=framing(bytes(raw));canonical=enc(final);e['expected_final_canonical_sha256']=sha(canonical);e['expected_final_raw_sha256']=sha(canonical+ending)
  entries.append(e)
 entries.sort(key=lambda e:(e['path'],e['line_index']))
 return {'schema':'catalog-sidecar-metadata-repair-plan-v1','source_version_id':source_version_id,'source_sha256':source_sha256,'entries':entries,'counts':dict(sorted(counts.items())),'existing_batch_marker_present':'_CATALOG/.enrich-bedrock-batch.json' in inv,'lineage_verified':False,'ocr_verified':False,'enrichment_verified':False,'identifiers_verified':False,'automatic_action':'restore_sidecar_existence','apply_requirements':['revalidate_exact_original_and_text_metadata_pins','conditional_catalog_write_with_fresh_etag'],'maximum_entries':MAX_ENTRIES}
def loads(raw):
 def hook(pairs):
  d={}
  for k,v in pairs:
   if k in d:raise ValueError('duplicate_json_key')
   d[k]=v
  return d
 return json.loads(raw.decode('utf8'),object_pairs_hook=hook,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite_json')))
def framing(raw):
 if raw.endswith(b'\r\n'):return raw[:-2],b'\r\n'
 if raw.endswith(b'\n'):return raw[:-1],b'\n'
 return raw,b''
def apply_row(raw_line,entry):
 if not isinstance(raw_line,(bytes,bytearray)) or type(entry) is not dict or entry.get('action')!='restore_sidecar_existence':raise ValueError('apply_invalid')
 raw=bytes(raw_line)
 body,ending=framing(raw)
 if sha(raw)==entry.get('expected_final_raw_sha256'):
  row=loads(body)
  if row.get('path')==entry.get('path') and row.get('sidecar') is True:return raw
 if sha(raw)!=entry.get('raw_line_sha256'):raise ValueError('stale_raw_line')
 row=loads(body)
 if type(row) is not dict or row.get('path')!=entry.get('path') or ('sidecar'in row and type(row['sidecar']) is not bool) or row.get('sidecar',False) is not False:raise ValueError('apply_invalid')
 row['sidecar']=True;out=enc(row)+ending
 if sha(enc(row))!=entry.get('expected_final_canonical_sha256') or sha(out)!=entry.get('expected_final_raw_sha256'):raise ValueError('final_digest_mismatch')
 return out
