"""需求池 CRUD（T09）。任务类型：代蹲 / 代出 等。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Lead
from app.schemas import LeadCreate, LeadOut

router = APIRouter(prefix="/leads", tags=["leads"])


@router.get("", response_model=list[LeadOut])
def list_leads(status: str = None, task_type: str = None, db: Session = Depends(get_db)):
    q = db.query(Lead)
    if status:
        q = q.filter(Lead.status == status)
    if task_type:
        q = q.filter(Lead.task_type == task_type)
    return q.order_by(Lead.id.desc()).all()


@router.post("", response_model=LeadOut, status_code=201)
def create_lead(lead: LeadCreate, db: Session = Depends(get_db)):
    if not lead.demand and not lead.task_type:
        raise HTTPException(400, "需求与任务类型至少填一项")
    row = Lead(**lead.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/{lead_id}", response_model=LeadOut)
def get_lead(lead_id: int, db: Session = Depends(get_db)):
    row = db.get(Lead, lead_id)
    if not row:
        raise HTTPException(404, "需求不存在")
    return row


@router.put("/{lead_id}", response_model=LeadOut)
def update_lead(lead_id: int, lead: LeadCreate, db: Session = Depends(get_db)):
    """状态流转（寻找中 → 已完成）走这里。"""
    row = db.get(Lead, lead_id)
    if not row:
        raise HTTPException(404, "需求不存在")
    for k, v in lead.model_dump().items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{lead_id}", status_code=204)
def delete_lead(lead_id: int, db: Session = Depends(get_db)):
    row = db.get(Lead, lead_id)
    if not row:
        raise HTTPException(404, "需求不存在")
    db.delete(row)
    db.commit()
