export default function ConfirmModal({ dialog, onClose, theme }) {
  if (!dialog) return null;

  const C = theme;
  const { label, resolve } = dialog;
  const confirm = () => { onClose(); resolve(true); };
  const cancel  = () => { onClose(); resolve(false); };

  return (
    <div onClick={cancel} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 24px"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.surface,borderRadius:16,padding:"24px 20px",width:"100%",maxWidth:320,boxShadow:"0 8px 32px rgba(0,0,0,0.3)",border:`1px solid ${C.border}`}}>
        <div style={{fontSize:"0.94rem",fontWeight:700,color:C.text,marginBottom:18,lineHeight:1.5,textAlign:"center"}}>
          <span style={{color:C.accent}}>"{label}"</span>을(를)<br/>미완료로 변경하시겠습니까?
        </div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={cancel} style={{flex:1,padding:"11px 0",borderRadius:10,border:`1.5px solid ${C.border}`,background:C.bg,color:C.muted,fontSize:"0.875rem",fontWeight:700,cursor:"pointer"}}>취소</button>
          <button onClick={confirm} style={{flex:1,padding:"11px 0",borderRadius:10,border:"none",background:C.accent,color:"#fff",fontSize:"0.875rem",fontWeight:800,cursor:"pointer"}}>변경</button>
        </div>
      </div>
    </div>
  );
}
