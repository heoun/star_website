"""Reproduce the clearly labelled archive fixture (requires reportlab)."""
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
out = Path(__file__).with_name('executed-lease-mock.pdf')
styles = getSampleStyleSheet()
styles['Title'].textColor = colors.HexColor('#205570')
doc = SimpleDocTemplate(str(out), pagesize=(612,792), rightMargin=48,leftMargin=48,topMargin=48,bottomMargin=48)
story=[Paragraph('MOCK ARCHIVE FILE',styles['Title']),Spacer(1,16),Paragraph('Rental workflow demonstration only',styles['Heading2']),Paragraph('This synthetic PDF tests the completed-lease archive and download controls. It is not an executed contract, contains no real signatures, and is not the full generated lease.',styles['BodyText']),Spacer(1,24)]
rows=[['Workflow record','Mock evidence'],['Application group','All required information received'],['Landlord decision','Agreed to proceed'],['Lease draft','Generated from saved lease values'],['Tenant signing','Synthetic receipt recorded first'],['Landlord signing','Synthetic receipt recorded after tenants'],['Archive','This clearly labelled PDF fixture']]
t=Table(rows,colWidths=[180,336]);t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e6f0f4')),('TEXTCOLOR',(0,0),(-1,0),colors.HexColor('#205570')),('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),('FONTSIZE',(0,0),(-1,-1),10),('GRID',(0,0),(-1,-1),.5,colors.HexColor('#dce5eb')),('TOPPADDING',(0,0),(-1,-1),12),('BOTTOMPADDING',(0,0),(-1,-1),12)]));story += [t,Spacer(1,24),Paragraph('The application-specific names, unit, lease values, and signing references remain in the saved rental record. Download the lease draft from that case to inspect its populated Word template.',styles['BodyText'])]
doc.build(story)
