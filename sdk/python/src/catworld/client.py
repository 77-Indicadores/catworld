from __future__ import annotations
import time
from pathlib import Path
from typing import Any
import httpx
from .exceptions import AuthenticationError,PermissionDeniedError,ValidationError,QueryTimeoutError,ConnectionError
class CatworldClient:
    def __init__(self,base_url:str,token:str,timeout:float=30):
        self._client=httpx.Client(base_url=base_url.rstrip("/"),headers={"Authorization":f"Bearer {token}"},timeout=timeout)
    def close(self): self._client.close()
    def __enter__(self): return self
    def __exit__(self,*_): self.close()
    def projects(self): return self._request("GET","/api/v1/projects")
    def datasets(self): return self._request("GET","/api/v1/datasets")
    def tables(self,dataset_id:str): return self._request("GET",f"/api/v1/datasets/{dataset_id}/tables")
    def rows(self,table_id:str,limit:int=100): return self._request("GET",f"/api/v1/tables/{table_id}/rows",params={"limit":limit})
    def query(self,sql:str,timeout:int=30,limit:int=10000): return self._request("POST","/api/v1/queries",json={"sql":sql,"timeout":timeout,"limit":limit})
    def upload(self,path:str|Path,dataset_id:str,mode:str="replace",key_column:str|None=None,poll_interval:float=2):
        file=Path(path);created=self._request("POST","/api/v1/uploads",json={"filename":file.name,"sizeBytes":file.stat().st_size});
        for attempt in range(3):
            with file.open("rb") as stream:
                response=self._client.put(created["sas"]["url"],content=stream,headers={"content-type":"application/octet-stream"},timeout=None)
            if response.status_code!=499 or attempt==2:response.raise_for_status();break
            time.sleep(1)
        upload_id=created["upload"]["id"];self._request("POST",f"/api/v1/uploads/{upload_id}/uploaded");preview=self._wait(upload_id,"AWAITING_CONFIRMATION",poll_interval)
        mapping=preview["previewJson"];import json as _json
        if isinstance(mapping,str): mapping=_json.loads(mapping)
        self._request("POST",f"/api/v1/uploads/{upload_id}/confirm",json={"datasetId":dataset_id,"mode":mode,"keyColumn":key_column,"mapping":mapping["columns"]})
        return self._wait(upload_id,"COMPLETED",poll_interval)
    def _wait(self,upload_id,target,interval):
        for _ in range(1800):
            upload=self._request("GET",f"/api/v1/uploads/{upload_id}")
            if upload["status"]==target:return upload
            if upload["status"]=="FAILED":raise ValidationError(upload.get("errorMessage") or "Upload falhou")
            time.sleep(interval)
        raise QueryTimeoutError("Tempo de processamento excedido")
    def _request(self,method,path,**kwargs)->Any:
        try: response=self._client.request(method,path,**kwargs)
        except httpx.HTTPError as exc: raise ConnectionError(str(exc)) from exc
        if response.is_success:return response.json()["data"]
        body=response.json();message=body.get("error",{}).get("message",response.text)
        if response.status_code==401:raise AuthenticationError(message)
        if response.status_code==403:raise PermissionDeniedError(message)
        if response.status_code in (400,422):raise ValidationError(message)
        if response.status_code==408:raise QueryTimeoutError(message)
        raise ConnectionError(message)