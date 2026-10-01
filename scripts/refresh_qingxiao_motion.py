#!/usr/bin/env python3
"""Rebuild the approved flat Qingxiao artwork offline, without model-specific runtime code."""

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from build_qingxiao_form_action_variants import attack_tint, demon_tint, blend_frame
from build_qingxiao_pet_sprites import effect_layer, composite_external_effect, connected_components, effect_canvas, draw_orb
from build_qingxiao_sword_qi_focus import chroma_key_donor, extract_effect, reveal_effect

SIZE = 512
REGISTRATION = {
    'wave': (0.85, (18, 55), (0, 15)),
    'sweep': (0.875, (33, 37), (-7, 0)),
    'hmph': (0.875, (69, -30), (0, -7)),
    'remind': (0.825, (71, -38), (28, 20)),
    'conjure': (0.8, (30, 50), (20, 20)),
    'expressions': (0.875, (67, -58), (0, 0)),
}
REST = {
    'left': [(180,308),(203,318),(194,344),(174,369),(149,378),
             (119,377),(110,365),(119,344),(144,331),(164,320)],
    'right': [(296,323),(324,338),(350,367),(364,390),(361,405),
              (326,409),(317,392),(309,365),(295,349)],
}
POLYGONS = {
    'wave': [
        [],
        [(184,308),(203,320),(180,354),(151,363),(125,350),(119,317),(129,301),(151,307),(174,316)],
        [(184,308),(203,320),(181,351),(145,360),(123,336),(125,307),(127,279),(147,260),(164,272),(167,302)],
        [(184,308),(203,320),(181,355),(133,364),(114,341),(119,295),(110,251),(109,210),(148,203),(162,223),(160,267),(176,300)],
        [(184,308),(203,320),(181,355),(133,364),(114,341),(119,295),(110,251),(109,210),(153,203),(167,223),(163,267),(176,300)],
        [(184,308),(203,320),(181,355),(133,364),(117,340),(123,292),(118,251),(125,225),(155,226),(163,249),(168,291)],
    ],
    'sweep': [
        [],
        [(184,312),(202,322),(187,350),(163,369),(126,368),(110,350),(113,329),(140,322),(167,327)],
        [(184,312),(202,322),(186,353),(166,373),(127,371),(115,352),(121,331),(145,325),(165,327)],
        [(184,312),(202,322),(212,331),(227,345),(222,369),(196,369),(171,356),(155,350),(158,327)],
        [(184,312),(202,322),(223,329),(240,340),(239,370),(215,376),(191,362),(168,355),(158,335)],
        [(184,312),(202,322),(230,331),(240,346),(233,368),(213,371),(191,360),(166,352),(158,330)],
    ],
    'hmph': [
        [],
        [(183,306),(202,319),(187,347),(162,362),(137,345),(129,325),(126,303),(145,289),(162,307)],
        [(183,306),(205,320),(221,326),(234,341),(225,354),(198,352),(168,355),(151,352),(151,330)],
        [(183,306),(205,320),(226,327),(234,340),(225,354),(198,353),(166,357),(149,351),(151,331)],
        [(183,306),(205,320),(228,326),(235,337),(225,352),(197,351),(168,355),(151,350),(151,328)],
        [(183,306),(203,320),(186,350),(165,362),(143,348),(130,330),(132,311),(151,308),(171,321)],
    ],
    'remind': [
        [],
        [(299,326),(311,310),(340,309),(354,332),(351,357),(355,382),(336,389),(318,369),(304,354)],
        [(299,326),(312,304),(306,285),(319,276),(336,289),(341,320),(347,346),(351,377),(334,389),(315,367),(302,350)],
        [(299,326),(301,304),(304,272),(302,253),(315,248),(320,274),(337,287),(342,321),(352,376),(334,389),(314,366),(301,349)],
        [(299,326),(302,304),(310,276),(309,257),(321,252),(326,274),(341,290),(345,328),(354,378),(335,389),(314,366),(301,349)],
        [(299,326),(320,331),(347,352),(363,373),(363,399),(340,402),(322,378),(307,356)],
    ],
    'conjure': [
        [],
        [(299,326),(318,325),(342,329),(359,347),(358,372),(339,390),(320,373),(303,350)],
        [(299,326),(315,310),(334,296),(337,270),(350,255),(369,256),(379,281),(369,310),(357,337),(362,371),(337,391),(318,366)],
        [(299,326),(316,309),(343,286),(352,267),(374,250),(394,254),(397,274),(379,292),(368,322),(365,369),(338,390),(316,366)],
        [(299,326),(315,307),(337,284),(338,263),(352,248),(370,253),(381,273),(365,301),(358,334),(363,370),(337,390),(316,366)],
        [(299,326),(319,324),(346,330),(368,346),(373,369),(357,381),(338,391),(320,368),(303,350)],
    ],
}
PLUCK_ORDERS = [
    [0,2,4,1,3,4,2,0], [0,1,2,4,3,2,5,0],
    [0,4,2,3,1,4,5,0], [0,2,1,3,4,2,5,0],
    [0,1,4,2,3,4,5,0], [0,2,4,3,1,2,5,0],
    [0,4,1,2,3,2,5,0], [0,1,3,4,2,4,5,0],
    [0,2,3,1,4,2,5,0], [0,4,2,1,3,1,5,0],
]
PLUCK_DURATIONS = [50,70,70,70,100,70,70,250]


def clean(image):
    array = np.asarray(image.convert('RGBA')).copy()
    array[array[:,:,3] <= 4] = 0
    return Image.fromarray(array)


def polygon(points, blur=0.8):
    image = Image.new('L',(SIZE*4,SIZE*4))
    ImageDraw.Draw(image).polygon([(x*4,y*4) for x,y in points],fill=255)
    image = image.resize((SIZE,SIZE),Image.Resampling.LANCZOS)
    image = image.filter(ImageFilter.GaussianBlur(blur))
    return Image.fromarray(np.where(np.asarray(image)<3,0,np.asarray(image)).astype('uint8'))


def translated(image, offset):
    output = Image.new(image.mode,(SIZE,SIZE))
    output.paste(image,offset)
    return output


def align_static_patch(image, reference, box, radius=60):
    x0,y0,x1,y1 = box
    target = np.asarray(reference.crop(box).convert('RGB').resize((40,32)),dtype=float)
    target -= target.mean(axis=(0,1))
    best = (float('inf'),0,0)
    for dy in range(-radius,radius+1,2):
        for dx in range(-16,17,2):
            sample = np.asarray(image.crop((x0+dx,y0+dy,x1+dx,y1+dy)).convert('RGB').resize((40,32)),dtype=float)
            sample -= sample.mean(axis=(0,1))
            score = float(np.mean((sample-target)**2))
            if score < best[0]:
                best = (score,dx,dy)
    return translated(image,(-best[1],-best[2])), (-best[1],-best[2])


def load_native_family(sources, name, qa):
    source = Image.open(sources / f'{name}.png').convert('RGBA')
    width,height = source.width//3,source.height//2
    scale,offset,arm_offset = REGISTRATION[name]
    raw = []
    registration = []
    for i in range(6):
        cell = source.crop((i%3*width,i//3*height,(i%3+1)*width,(i//3+1)*height))
        cell = cell.resize((round(width*scale),round(height*scale)),Image.Resampling.LANCZOS)
        frame = Image.new('RGBA',(SIZE,SIZE));frame.paste(cell,offset)
        if i:
            frame,adjustment = align_static_patch(frame,raw[0],(176,116,285,199))
        else:
            adjustment = (0,0)
        raw.append(frame)
        registration.append(adjustment)
    frames = [clean(translated(frame,arm_offset)) for frame in raw]
    contact(frames,[f'{name} {i}' for i in range(6)],qa / f'{name}-registered.png')
    return frames, registration


def render(image, color='#202631', size=256):
    output = Image.new('RGBA',(SIZE,SIZE),color)
    output.alpha_composite(image)
    return output.convert('RGB').resize((size,size),Image.Resampling.LANCZOS)


def contact(frames, labels, path):
    columns = min(6,len(frames));rows = math.ceil(len(frames)/columns)
    output = Image.new('RGB',(columns*256,rows*278),'#202631')
    draw = ImageDraw.Draw(output)
    for i,(frame,label) in enumerate(zip(frames,labels)):
        x,y=i%columns*256,i//columns*278
        output.paste(render(frame),(x,y+22));draw.text((x+4,y+4),label,fill='white')
    output.save(path)


def gif(frames,durations,path,color='#202631'):
    images = [render(frame,color) for frame in frames]
    atlas = Image.new('RGB',(256*len(images),256))
    for i,image in enumerate(images):
        atlas.paste(image,(i*256,0))
    palette = atlas.quantize(colors=256,method=Image.Quantize.MEDIANCUT)
    images = [image.quantize(palette=palette,dither=Image.Dither.NONE) for image in images]
    images[0].save(path,save_all=True,append_images=images[1:],duration=durations,
                   loop=0,optimize=False,disposal=2)


def gesture_family(base,plate,raw,name):
    side = 'right' if name in ('remind','conjure') else 'left'
    rest = polygon(REST[side])
    background = Image.composite(plate,base,rest)
    family = [base.copy()]
    for points,donor in zip(POLYGONS[name][1:],raw[1:]):
        array=np.asarray(donor);rgb=array[:,:,:3].astype(int)
        y,x=np.indices((SIZE,SIZE))
        skin=(array[:,:,3]>20)&(rgb[:,:,0]>185)&(rgb[:,:,2]>130)&(rgb[:,:,0]-rgb[:,:,2]>14)&(rgb[:,:,0]-rgb[:,:,1]<55)
        if side=='right':
            skin &= (x>290)&(x<425)&(y>225)&(y<406)
        else:
            skin &= (((x>95)&(x<180)&(y>185)&(y<280))|((x>100)&(x<245)&(y>=280)&(y<385)))
            if name != 'hmph':
                skin &= ~((x>=215)&(x<=280)&(y>=274)&(y<=324))
        corridor=polygon(points)
        owned=np.zeros((SIZE,SIZE),dtype='uint8')
        for component in connected_components(skin,8):
            ys,xs=zip(*component)
            if np.count_nonzero(np.asarray(corridor)[ys,xs]>32)>8:
                owned[ys,xs]=255
        hand_mask=Image.fromarray(owned).filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(0.5))
        corridor=ImageChops.lighter(corridor,hand_mask)
        pixels=np.asarray(corridor).copy()
        pixels[274:325,215:281]=np.asarray(hand_mask)[274:325,215:281] if name == 'hmph' else 0
        corridor=Image.fromarray(pixels)
        family.append(clean(Image.composite(donor,background,corridor)))
    return family


def face_states(base,raw):
    # Register native expression donors by static forehead, then clip separate eye and lip ROIs.
    _,offset = align_static_patch(raw[0],base,(190,207,278,239),radius=24)
    raw = [translated(frame,offset) if i<3 else
           align_static_patch(frame,base,(190,207,278,239),radius=32)[0]
           for i,frame in enumerate(raw)]
    eyes = Image.new('L',(SIZE,SIZE));draw=ImageDraw.Draw(eyes)
    for box in [(194,207,232,238),(243,207,280,238)]:
        draw.ellipse(box,fill=255)
    mouth = Image.new('L',(SIZE,SIZE))
    ImageDraw.Draw(mouth).ellipse((226,237,246,250),fill=255)
    eyes=eyes.filter(ImageFilter.GaussianBlur(0.6))
    mouth=mouth.filter(ImageFilter.GaussianBlur(0.6))
    mask=ImageChops.lighter(eyes,mouth)
    states=[base.copy()]
    for i,donor in enumerate(raw[1:],1):
        feature_mask = eyes if i in (1,5) else mouth if i==2 else mask
        states.append(clean(Image.composite(donor,base,feature_mask)))
    return states,mask


def expression(frame,face,mask):
    return clean(Image.composite(face,frame,mask))


def with_aura(frame,progress=1.0,kind='enter',anchor=None):
    array=np.asarray(frame)
    return Image.fromarray(composite_external_effect(array,effect_layer(kind,progress,anchor),array[:,:,3]>0))


def tint(frame,form):
    operation={'attack':attack_tint,'demon':demon_tint}.get(form)
    return Image.fromarray(operation(np.asarray(frame))) if operation else frame.copy()


def conjuring_anchor(frame):
    array=np.asarray(frame)
    rgb=array[:,:,0:3].astype(int)
    y,x=np.indices((SIZE,SIZE))
    skin=(array[:,:,3]>100)&(rgb[:,:,0]>185)&(rgb[:,:,0]-rgb[:,:,2]>14)&(rgb[:,:,1]>120)
    skin &= (x>310)&(x<404)&(y>240)&(y<323)
    ys,xs=np.where(skin)
    return (float(xs.mean()),float(ys.mean())-12) if len(xs)>20 else (374.,257.)


def save_animation(root,key,spec,frames,durations,qa,report):
    columns=4 if len(frames)>6 else 3
    sheet=Image.new('RGBA',(columns*SIZE,math.ceil(len(frames)/columns)*SIZE))
    for i,frame in enumerate(frames):
        frame=clean(frame);array=np.asarray(frame)
        assert not np.any(array[[0,-1],:,3]) and not np.any(array[:,[0,-1],3]), key
        sheet.paste(frame,(i%columns*SIZE,i//columns*SIZE))
    path=root/spec['file'];path.parent.mkdir(parents=True,exist_ok=True)
    label=key.replace('/','-')
    try:
        existing=np.asarray(Image.open(path).convert('RGBA')) if path.exists() else None
    except OSError:
        existing=None
    reuse=(path.exists() and spec['frameDurations']==durations
           and all((qa/f'{label}{suffix}').exists() for suffix in ('-contact.png','.gif','-light.gif','-difference.png'))
           and existing is not None and np.array_equal(np.asarray(sheet),existing))
    if not reuse:
        pending=path.with_suffix('.pending.webp')
        sheet.save(pending,lossless=True,exact=True,method=6)
        assert np.array_equal(np.asarray(sheet),np.asarray(Image.open(pending).convert('RGBA'))),key
        pending.replace(path)
    decoded=np.asarray(Image.open(path).convert('RGBA'))
    assert np.array_equal(np.asarray(sheet),decoded),key
    spec.update(frames=len(frames),columns=columns,frameDurations=durations)
    if not reuse:
        contact(frames,[f'{label} {i}' for i in range(len(frames))],qa/f'{label}-contact.png')
        gif(frames,durations,qa/f'{label}.gif')
        gif(frames,durations,qa/f'{label}-light.gif','white')
        difference=np.max(np.stack([np.asarray(ImageChops.difference(frame,frames[0])) for frame in frames]),axis=0)
        Image.fromarray(difference).convert('RGB').save(qa/f'{label}-difference.png')
    report[key]={'frames':len(frames),'durationMs':sum(durations),
                 'uniqueFrames':len({hashlib.sha256(np.asarray(frame).tobytes()).hexdigest() for frame in frames}),
                 'firstLastEqual':np.array_equal(np.asarray(frames[0]),np.asarray(frames[-1])),
                 'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def build(model,qa):
    qa.mkdir(parents=True,exist_ok=True);sources=model/'references/motion'
    base=clean(Image.open(sources/'normal-base.png'))
    plate=clean(Image.open(sources/'plate.png').resize((SIZE,SIZE),Image.Resampling.LANCZOS))
    families={};registrations={}
    for name in REGISTRATION:
        raw,registrations[name]=load_native_family(sources,name,qa)
        families[name]=raw if name=='expressions' else gesture_family(base,plate,raw,name)
        contact(families[name],[f'{name} {i}' for i in range(6)],qa/f'{name}-poses.png')
    faces,face_mask=face_states(base,families['expressions'])
    contact(faces,['calm','closed','happy','annoyed','concerned','drowsy'],qa/'face-states.png')
    plucks=[clean(Image.open(sources/f'pose-{i:02d}.png')) for i in range(6)]
    assert np.array_equal(np.asarray(base),np.asarray(plucks[0]))
    top=json.loads((model/'model.json').read_text())
    manifests=[('',model,top)]
    for path in sorted((model/'modules').glob('*/module.json')):
        manifests.append((path.parent.name+'/',path.parent,json.loads(path.read_text())))
    pet=with_aura(base)
    blink=[base,base,faces[5],faces[1],faces[5],base]
    normal={
        'idle':blink,
        'pet-idle':[pet]*10+[with_aura(faces[1]),pet],
        'pet-enter':[with_aura(base,float(p)) for p in np.linspace(0,1,8)],
        'pet-exit':[with_aura(base,float(p)) for p in np.linspace(1,0,8)],
    }
    for i,order in enumerate(PLUCK_ORDERS,1):
        normal[f'pluck-{i:02d}']=[plucks[index] for index in order]
    orders={
        'pet-chime':('sweep',[0,1,2,3,4,5,4,3,2,1,0,0]),
        'lively/glissando':('sweep',[0,1,2,3,4,5,3,4,5,2,1,0]),
        'lively/wink-wave':('wave',[0,1,2,3,4,3,4,3,4,5,2,1,0,0,0,0]),
        'tsundere/remind':('remind',[0,1,2,3,4,3,4,2,1,5,0,0]),
        'tsundere/hmph':('hmph',[0,1,2,3,4,3,4,3,2,5,1,0]),
        'lively/summon-orb':('conjure',[0,1,2,3,4,3,4,3,4,3,4,3,2,5,1,0]),
        'lively/sword-qi-focus':('conjure',[0,1,2,3,4,3,4,3,4,3,4,3,2,5,1,0]),
    }
    emotion={'pet-chime':2,'lively/wink-wave':2,'tsundere/remind':4,'tsundere/hmph':3}
    sword=Image.fromarray(extract_effect(chroma_key_donor(model/'references/sword-qi-focus-peak-donor.png')))
    for key,(family,order) in orders.items():
        count=len(order);frames=[]
        for i,index in enumerate(order):
            progress=math.sin(math.pi*i/(count-1))**2
            character=families[family][index]
            if 2<=i<count-2 and key in emotion:
                character=expression(character,faces[emotion[key]],face_mask)
            kind=key.split('/')[-1].removeprefix('pet-')
            anchor=conjuring_anchor(character) if 'summon' in key else (132,226) if 'wave' in key else None
            frame=with_aura(character,progress,kind,anchor)
            if 'summon-orb' in key:
                palm=conjuring_anchor(character)
                orb=effect_canvas()
                draw_orb(orb,(palm[0]+40,palm[1]-38),18+progress*7,progress)
                frame=clean(Image.alpha_composite(with_aura(character),orb.resize((SIZE,SIZE),Image.Resampling.LANCZOS)))
            if 'sword-qi' in key and progress>0:
                energy=Image.fromarray(reveal_effect(np.asarray(sword),progress)).transpose(Image.Transpose.FLIP_LEFT_RIGHT)
                palm=conjuring_anchor(character)
                energy=translated(energy,(round(palm[0]-360),round(palm[1]-247)))
                energy_pixels=np.asarray(energy).copy()
                energy_pixels[np.asarray(character)[:,:,3]>0]=0
                energy=Image.fromarray(energy_pixels)
                frame=clean(Image.alpha_composite(frame,energy))
            frames.append(frame)
        frames[0]=pet.copy();frames[-1]=pet.copy();normal[key]=frames
    face_orders={
        'pet-content':[0,0,2,2,2,2,2,2,2,2,0,0],
        'pet-curious':[0,0,4,4,4,4,4,4,4,4,0,0],
        'pet-doze':[0,0,5,5,1,1,1,1,5,5,0,0],
        'pet-dream':[0,0,5,1,1,1,1,1,1,5,0,0],
        'lively/startled':[0,0,4,4,4,4,4,4,4,4,0,0],
        'pet-drowsy':[5,5,5,1,1,5,5,5],
        'pet-nap':[1]*8,'pet-sleep':[1]*8,
        'pet-happy':[2]*10+[1,2],
        'pet-annoyed':[3]*10,'pet-concerned':[4]*10,
    }
    for key,order in face_orders.items():
        frames=[]
        for i,state in enumerate(order):
            kind=key.split('/')[-1].removeprefix('pet-')
            is_loop=key in ('pet-drowsy','pet-nap','pet-sleep','pet-happy','pet-annoyed','pet-concerned')
            if key in ('pet-nap','pet-sleep'):
                kind='doze' if key=='pet-nap' else 'dream'
                progress=0.4+0.2*math.sin(2*math.pi*i/len(order))
            else:
                progress=0 if is_loop else math.sin(math.pi*i/(len(order)-1))**2
            frames.append(with_aura(faces[state],progress,kind))
        normal[key]=frames
    forms={form:tint(pet,form) for form in ('normal','attack','demon')}
    normal['pet-attack-idle']=[tint(frame,'attack') for frame in [pet,pet,with_aura(faces[5]),with_aura(faces[1]),with_aura(faces[5]),pet]]
    normal['pet-demon-idle']=[tint(frame,'demon') for frame in [pet,pet,with_aura(faces[5]),with_aura(faces[1]),with_aura(faces[5]),pet]]
    progress=[0,.08,.18,.35,.58,.78,.94,1,1,.94,.78,.58,.35,.18,.08,0]
    def transition(start,end,values):
        return [Image.fromarray(blend_frame(np.asarray(start),np.asarray(end),p)) for p in values]
    normal['transform']=transition(base,tint(base,'attack'),progress)
    normal['pet-heart-demon']=transition(pet,forms['demon'],progress)
    for source,target in [('normal','attack'),('demon','attack'),('normal','demon'),('attack','demon'),('attack','normal'),('demon','normal')]:
        normal[f'pet-{source}-to-{target}']=transition(forms[source],forms[target],[0,.12,.32,.62,.86,1,1,1])
    for source,target in [('normal','attack'),('attack','demon'),('demon','normal')]:
        normal[f'pet-{source}-{target}-return']=transition(forms[source],forms[target],progress)
    for form in ('attack','demon'):
        states=[0,0,5,1,1,5,0,0]
        strength=[0,.2,.6,1,1,.6,.2,0]
        normal[f'pet-{form}-flourish']=[tint(with_aura(faces[state],p,'curious'),form) for state,p in zip(states,strength)]
    report={}
    for prefix,root,manifest in manifests:
        for name,spec in manifest.get('animations',{}).items():
            key=prefix+name
            if key=='pet-relaxed':
                continue
            if key in normal:
                frames=normal[key]
            else:
                form='attack' if 'attack-' in name else 'demon' if 'demon-' in name else None
                if not form:
                    raise ValueError(f'unhandled animation: {key}')
                source=prefix+name.replace(form+'-','',1)
                frames=[tint(frame,form) for frame in normal[source]]
            durations=PLUCK_DURATIONS if key.startswith('pluck-') else spec['frameDurations']
            if key=='idle' or key in ('pet-attack-idle','pet-demon-idle'):
                durations=[4200,100,55,45,55,120]
            assert len(durations)==len(frames),key
            save_animation(root,key,spec,frames,durations,qa,report)
        if prefix=='':
            manifest['animations']['pet-relaxed'].update({k:manifest['animations']['pet-idle'][k] for k in ('frames','columns')})
            manifest['bubbles']['anchorY']=380
        path=root/('module.json' if prefix else 'model.json')
        path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    base.save(model/'references/canonical-base.png')
    base.save(model/'resources/cover.png')
    tint(faces[1],'attack').save(model/'references/attack-form-closed-eye-donor.png')
    tint(faces[1],'demon').save(model/'references/demon-form-closed-eye-donor.png')
    (qa/'refresh-report.json').write_text(json.dumps({'registration':registrations,'animations':report},indent=2)+'\n')
    print(f'Built {len(report)} unique sheets; QA: {qa}')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir',required=True,type=Path)
    parser.add_argument('--qa-dir',required=True,type=Path)
    args=parser.parse_args()
    build(args.model_dir.resolve(),args.qa_dir.resolve())
