; ===========================================================================
;  PHOSPHOR boot demo - original 6809 program, MIT licensed
;
;  Runs from the system ROM slot ($E000-$FFFF) with no BIOS at all:
;  every vector is drawn by programming the VIA 6522 directly.
;
;    DAC (port A) + analog mux (PB0-PB2)  -> X/Y integrator inputs, Z, offset
;    timer 1 one-shot driving PB7          -> RAMP, i.e. the vector "scale"
;    shift register output on CB2          -> BLANK (beam on/off)
;    CA2                                   -> ZERO (recentre the beam)
;    PSG via port A + BDIR/BC1 (PB4/PB3)   -> music, controller buttons
;
;  Build:  node tools/build-demo.js
; ===========================================================================

VIA_ORB    EQU $D000
VIA_ORA    EQU $D001
VIA_DDRB   EQU $D002
VIA_DDRA   EQU $D003
VIA_T1CL   EQU $D004
VIA_T1CH   EQU $D005
VIA_T2CL   EQU $D008
VIA_T2CH   EQU $D009
VIA_SR     EQU $D00A
VIA_ACR    EQU $D00B
VIA_PCR    EQU $D00C
VIA_IFR    EQU $D00D
VIA_IER    EQU $D00E

FRAME_T    EQU 30000          ; 50 Hz refresh at 1.5 MHz
CUBE_SCALE EQU $80
MOVE_SCALE EQU $80
RING_SCALE EQU $60
U          EQU 16             ; font grid unit, in DAC steps
MV         EQU $00            ; vector list opcode: move (beam off)
DR         EQU $FF            ; vector list opcode: draw (beam on)
ENDL       EQU $01            ; vector list opcode: end of list

; ---------------------------------------------------------------- RAM ----
           ORG $C800
frame      RMB 1
angA       RMB 1              ; spin angle (around Y)
angB       RMB 1              ; tilt oscillator phase
tilt       RMB 1
spin       RMB 1              ; signed spin speed
phase      RMB 1              ; text wobble phase
bright     RMB 1              ; title brightness
btn        RMB 1              ; buttons held (active high)
btnprev    RMB 1
mute       RMB 1
note       RMB 1
ntimer     RMB 1
sinA       RMB 1
cosA       RMB 1
sinB       RMB 1
cosB       RMB 1
vx         RMB 1              ; vertex being transformed
vy         RMB 1
vz         RMB 1
x1         RMB 1
z1         RMB 1
y2         RMB 1
pf         RMB 1              ; perspective factor
ys         RMB 1
tmp        RMB 2
tmpa       RMB 1
tmpb       RMB 1
count      RMB 1
idx        RMB 1
pat        RMB 1
ptr        RMB 2
p0         RMB 2
p1         RMB 2
rang       RMB 1
rcos       RMB 1
ry         RMB 1
tx         RMB 1              ; text cursor and style
ty         RMB 1
tscale     RMB 1
twob       RMB 1
proj       RMB 16             ; 8 projected vertices: (y, x)
vlist      RMB 52             ; cube vector list built every frame

; ---------------------------------------------------------------- ROM ----
           ORG $E000
           SETDP $C8
           FCC "PHOSPHOR BOOT DEMO - (C) 2026 JIMMY KURC - MIT LICENSE"
           FCB 0

reset:
           lds  #$CBFF
           lda  #$C8
           tfr  a,dp
           lda  #$7F
           sta  VIA_IER        ; mask every VIA interrupt
           lda  #$FF
           sta  VIA_DDRA       ; port A drives the DAC
           lda  #$9F
           sta  VIA_DDRB       ; PB0-PB4 and PB7 are outputs
           lda  #$98
           sta  VIA_ACR        ; T1 one-shot on PB7, SR shift-out under phi2
           lda  #$CE
           sta  VIA_PCR        ; ZERO released
           ldx  #$C800
.clr       clr  ,x+
           cmpx #$C900
           bne  .clr
           lda  #2
           sta  spin
           jsr  psg_init
           ldd  #FRAME_T
           stb  VIA_T2CL
           sta  VIA_T2CH

main:
           lda  #$20
.wait      bita VIA_IFR        ; wait for the 50 Hz frame timer (T2)
           beq  .wait
           ldd  #FRAME_T
           stb  VIA_T2CL
           sta  VIA_T2CH
           inc  frame
           jsr  read_buttons
           jsr  update
           jsr  music
           jsr  draw_cube
           jsr  draw_ring
           jsr  draw_texts
           bra  main

; ----------------------------------------------------- beam primitives ----

; Recentre the beam and set the integrator offset to 0.
zero_ref:
           lda  #$CC
           sta  VIA_PCR        ; CA2 low: ZERO
           clr  VIA_ORA
           lda  #$02
           sta  VIA_ORB        ; mux on, channel 1: offset = 0
           lda  #$03
           sta  VIA_ORB        ; mux off
           lda  #$CE
           sta  VIA_PCR        ; release ZERO
           rts

; A = brightness (0..127)
intensity:
           sta  VIA_ORA
           lda  #$04
           sta  VIA_ORB        ; mux on, channel 2: Z axis
           lda  #$05
           sta  VIA_ORB
           rts

; Move the beam by (A=dy, B=dx) times the scale held in the T1 low latch.
moveto:
           sta  VIA_ORA        ; DAC = dy
           clr  VIA_ORB        ; mux on, channel 0: Y sample/hold
           lda  #$01
           sta  VIA_ORB        ; mux off, Y holds
           stb  VIA_ORA        ; DAC = dx, straight into the X integrator
           clr  VIA_T1CH       ; start T1 from its latch: RAMP low for `scale` cycles
           lda  #$40
.w         bita VIA_IFR
           beq  .w
           rts

; X -> vector list of (op, dy, dx) triplets terminated by ENDL.
; op is written straight into the shift register: $00 = beam off, $FF = on.
; The scale must already be in the T1 low latch. Runs with DP = $D0 so the
; VIA can be reached with fast direct-page accesses (like the real BIOS).
draw_list:
           lda  #$D0
           tfr  a,dp
.next      lda  ,x+
           cmpa #ENDL
           beq  .done
           ldb  ,x+
           stb  <$01           ; DAC = dy
           clr  <$00           ; mux on, channel 0: Y sample/hold
           inc  <$00           ; mux off
           ldb  ,x+
           stb  <$01           ; DAC = dx
           sta  <$0A           ; shift register: beam pattern
           clr  <$05           ; T1 high: RAMP on
           ldb  #$40
.w         bitb <$0D
           beq  .w
           bra  .next
.done      clr  <$0A           ; beam off
           lda  #$C8
           tfr  a,dp
           rts

; --------------------------------------------------------------- maths ----

; B = angle (0..255) -> A = 127*sin
sin:
           ldx  #sintab
           abx
           lda  ,x
           rts
cos:
           addb #64
           bra  sin

; Signed 8x8 multiply: D = A * B
smul:
           sta  tmpa
           stb  tmpb
           mul
           tst  tmpa
           bpl  .p1
           suba tmpb
.p1        tst  tmpb
           bpl  .p2
           suba tmpa
.p2        rts

; Signed A times unsigned B: D = A * B
sumul:
           sta  tmpa
           stb  tmpb
           mul
           tst  tmpa
           bpl  .p
           suba tmpb
.p         rts

; Rotate (vx,vy,vz) around Y by angA, around X by tilt, then project.
; Returns A = screen y, B = screen x.
xform:
           lda  vx             ; x1 = (x.cosA + z.sinA) >> 7
           ldb  cosA
           bsr  smul
           std  tmp
           lda  vz
           ldb  sinA
           bsr  smul
           addd tmp
           aslb
           rola
           sta  x1
           lda  vx             ; z1 = (z.cosA - x.sinA) >> 7
           ldb  sinA
           bsr  smul
           std  tmp
           lda  vz
           ldb  cosA
           bsr  smul
           subd tmp
           aslb
           rola
           sta  z1
           lda  z1             ; y2 = (y.cosB - z1.sinB) >> 7
           ldb  sinB
           bsr  smul
           std  tmp
           lda  vy
           ldb  cosB
           bsr  smul
           subd tmp
           aslb
           rola
           sta  y2
           lda  vy             ; z2 = (y.sinB + z1.cosB) >> 7
           ldb  sinB
           bsr  smul
           std  tmp
           lda  z1
           ldb  cosB
           bsr  smul
           addd tmp
           aslb
           rola
           adda #128           ; perspective factor from table[z2 + 128]
           tfr  a,b
           ldx  #persp
           abx
           lda  ,x
           sta  pf
           lda  y2
           ldb  pf
           bsr  sumul
           sta  ys
           lda  x1
           ldb  pf
           bsr  sumul
           tfr  a,b
           lda  ys
           rts

; -------------------------------------------------------------- update ----
update:
           lda  spin
           ldb  btn
           bitb #$02           ; button 2 held: spin faster
           beq  .ns
           lsla
           lsla
.ns        adda angA
           sta  angA
           lda  frame
           bita #$01
           bne  .nb
           inc  angB
.nb        lda  frame
           lsla
           lsla
           sta  phase
           ldb  frame          ; title brightness pulse
           lslb
           jsr  sin
           asra
           asra
           adda #$5C
           sta  bright
           ldb  angA
           jsr  sin
           sta  sinA
           ldb  angA
           jsr  cos
           sta  cosA
           ldb  angB           ; tilt = 24 + sin(angB)/8
           jsr  sin
           asra
           asra
           asra
           adda #24
           sta  tilt
           tfr  a,b
           jsr  sin
           sta  sinB
           ldb  tilt
           jsr  cos
           sta  cosB
           ldu  #cube_v
           ldy  #proj
           lda  #8
           sta  count
.v         ldd  ,u++
           sta  vx
           stb  vy
           lda  ,u+
           sta  vz
           jsr  xform
           std  ,y++
           dec  count
           bne  .v
           rts

; ------------------------------------------------------------- drawing ----
; Build a vector list for the cube from the projected vertices, then draw
; it in one continuous path (one ZERO, 16 vectors).
draw_cube:
           lda  #$7F
           jsr  intensity
           jsr  zero_ref
           lda  #CUBE_SCALE
           sta  VIA_T1CL
           ldu  #cube_path
           ldy  #vlist
           ldx  #proj
           clr  p0             ; previous point (y, x) starts at the centre
           clr  p0+1
.p         lda  ,u+
           cmpa #ENDL
           beq  .go
           sta  ,y+            ; op
           lda  ,u+            ; vertex index
           lsla
           ldd  a,x            ; A = y, B = x
           std  p1
           suba p0
           subb p0+1
           std  ,y++           ; relative move
           ldd  p1
           std  p0
           bra  .p
.go        lda  #ENDL
           sta  ,y
           ldx  #vlist
           jsr  draw_list
           rts

; A ring of 16 dots orbiting the cube. One ZERO, then relative moves.
draw_ring:
           jsr  zero_ref
           lda  #RING_SCALE
           sta  VIA_T1CL
           clr  idx
           clr  p0             ; previous dot (y, x)
           clr  p0+1
.dot       ldb  idx
           lslb
           lslb
           lslb
           lslb
           addb frame
           stb  rang
           jsr  cos
           sta  rcos
           asra
           asra
           adda #$60           ; dots in front are brighter
           jsr  intensity
           lda  rcos           ; y = -cos/8 (front of the ring is lower)
           asra
           asra
           asra
           nega
           sta  p1
           ldb  rang           ; x = sin
           jsr  sin
           sta  p1+1
           ldd  p1
           suba p0
           subb p0+1
           jsr  moveto
           ldd  p1
           std  p0
           lda  #$FF
           sta  VIA_SR         ; short beam-on pulse: a dot
           nop
           nop
           clr  VIA_SR
           inc  idx
           lda  idx
           cmpa #16
           bne  .dot
           rts

draw_texts:
           lda  bright
           jsr  intensity
           ldu  #title_str
           lda  #-97
           sta  tx
           lda  #101
           sta  ty
           lda  #40
           sta  tscale
           lda  #1
           sta  twob
           jsr  draw_text
           lda  #$46
           jsr  intensity
           ldu  #sub_str
           lda  #-66
           sta  tx
           lda  #-118
           sta  ty
           lda  #24
           sta  tscale
           clr  twob
           jsr  draw_text
           rts

; U -> list of glyph pointers (0 terminated); uses tx/ty/tscale/twob.
; Each glyph ends with a move to the origin of the next character, so the
; whole string is drawn after a single ZERO.
draw_text:
           jsr  zero_ref
           lda  #MOVE_SCALE
           sta  VIA_T1CL
           lda  ty
           ldb  tx
           jsr  moveto
           lda  tscale
           sta  VIA_T1CL
           clr  idx
           clr  ry             ; previous wobble offset
.ch        ldx  ,u++
           beq  .done
           stx  ptr
           tst  twob
           beq  .draw
           ldb  idx            ; wobble = sin(phase + 32*i) / 4
           lslb
           lslb
           lslb
           lslb
           lslb
           addb phase
           jsr  sin
           asra
           asra
           tfr  a,b
           suba ry             ; move by the change of wobble
           stb  ry
           clrb
           jsr  moveto
.draw      ldx  ptr
           jsr  draw_list
           inc  idx
           bra  .ch
.done      rts

; --------------------------------------------------------- sound & input ----

; A = PSG register, B = value
psg_write:
           sta  VIA_ORA
           lda  #$19
           sta  VIA_ORB        ; BDIR=1 BC1=1: latch address
           lda  #$01
           sta  VIA_ORB        ; inactive
           stb  VIA_ORA
           lda  #$11
           sta  VIA_ORB        ; BDIR=1 BC1=0: write data
           lda  #$01
           sta  VIA_ORB
           rts

psg_init:
           lda  #7
           ldb  #$3C           ; tone on channels A and B only
           jsr  psg_write
           lda  #11
           ldb  #$27           ; envelope period $0927 (~0.4 s decay)
           jsr  psg_write
           lda  #12
           ldb  #$09
           jsr  psg_write
           rts

; Read PSG port A (register 14): the four controller buttons.
read_buttons:
           lda  #14
           sta  VIA_ORA
           lda  #$19
           sta  VIA_ORB        ; latch register 14
           lda  #$01
           sta  VIA_ORB
           clr  VIA_DDRA       ; port A becomes an input
           lda  #$09
           sta  VIA_ORB        ; BDIR=0 BC1=1: read
           lda  VIA_ORA
           ldb  #$01
           stb  VIA_ORB
           ldb  #$FF
           stb  VIA_DDRA       ; port A back to output
           coma                ; buttons are active low
           sta  btn
           lda  btnprev
           coma
           anda btn            ; newly pressed buttons
           ldb  btn
           stb  btnprev
           bita #$01           ; button 1: reverse the spin
           beq  .n1
           neg  spin
.n1        bita #$04           ; button 3: music on/off
           beq  .n3
           com  mute
.n3        rts

; A soft pentatonic arpeggio on channels A and B (one octave apart).
music:
           tst  mute
           beq  .on
           lda  #8
           clrb
           jsr  psg_write
           lda  #9
           clrb
           jsr  psg_write
           rts
.on        dec  ntimer
           bpl  .done
           lda  #9
           sta  ntimer
           ldb  note
           incb
           andb #7
           stb  note
           ldx  #notes
           lslb
           abx
           ldd  ,x
           std  tmp
           lda  #0
           ldb  tmp+1
           jsr  psg_write      ; R0: channel A fine tune
           lda  #1
           ldb  tmp
           jsr  psg_write      ; R1: channel A coarse tune
           ldd  tmp
           lslb
           rola
           std  tmp
           lda  #2
           ldb  tmp+1
           jsr  psg_write      ; channel B: one octave lower
           lda  #3
           ldb  tmp
           jsr  psg_write
           lda  #8
           ldb  #$10
           jsr  psg_write      ; amplitudes follow the envelope
           lda  #9
           ldb  #$10
           jsr  psg_write
           lda  #13
           ldb  #$09
           jsr  psg_write      ; retrigger envelope: decay
.done      rts

; ---------------------------------------------------------------- data ----
notes:     FDB 213,179,142,120,107,120,142,160

cube_v:    FCB -46,-46,-46,  46,-46,-46,  46,46,-46,  -46,46,-46
           FCB -46,-46,46,   46,-46,46,   46,46,46,   -46,46,46
; One path covering the 12 edges: (op, vertex)
cube_path: FCB MV,0, DR,1, DR,2, DR,3, DR,0, DR,4, DR,5, DR,6, DR,7, DR,4
           FCB MV,5, DR,1, MV,2, DR,6, MV,7, DR,3, ENDL

title_str: FDB g_P,g_H,g_O,g_S,g_P,g_H,g_O,g_R,0
sub_str:   FDB g_6,g_8,g_0,g_9,g_SP,g_D,g_E,g_M,g_O,0

; Squared stroke font on a 4x6 grid, origin at the bottom-left corner.
; Each entry: op, dy, dx (relative moves). The last move of every glyph
; brings the beam to the origin of the next character (5 units right).
g_P:  FCB DR,6*U,0, DR,0,4*U, DR,-3*U,0, DR,0,-4*U, MV,-3*U,5*U, ENDL
g_R:  FCB DR,6*U,0, DR,0,4*U, DR,-3*U,0, DR,0,-4*U, MV,0,2*U, DR,-3*U,2*U, MV,0,U, ENDL
g_H:  FCB DR,6*U,0, MV,-3*U,0, DR,0,4*U, MV,3*U,0, DR,-6*U,0, MV,0,U, ENDL
g_O:  FCB DR,6*U,0, DR,0,4*U, DR,-6*U,0, DR,0,-4*U, MV,0,5*U, ENDL
g_0:  FCB DR,6*U,0, DR,0,4*U, DR,-6*U,0, DR,0,-4*U, DR,6*U,4*U, MV,-6*U,U, ENDL
g_8:  FCB DR,6*U,0, DR,0,4*U, DR,-6*U,0, DR,0,-4*U, MV,3*U,0, DR,0,4*U, MV,-3*U,U, ENDL
g_S:  FCB MV,6*U,4*U, DR,0,-4*U, DR,-3*U,0, DR,0,4*U, DR,-3*U,0, DR,0,-4*U, MV,0,5*U, ENDL
g_6:  FCB MV,6*U,4*U, DR,0,-4*U, DR,-6*U,0, DR,0,4*U, DR,3*U,0, DR,0,-4*U, MV,-3*U,5*U, ENDL
g_9:  FCB MV,3*U,4*U, DR,0,-4*U, DR,3*U,0, DR,0,4*U, DR,-6*U,0, DR,0,-4*U, MV,0,5*U, ENDL
g_D:  FCB DR,6*U,0, DR,0,3*U, DR,-U,U, DR,-4*U,0, DR,-U,-U, DR,0,-3*U, MV,0,5*U, ENDL
g_E:  FCB MV,0,4*U, DR,0,-4*U, DR,6*U,0, DR,0,4*U, MV,-3*U,-4*U, DR,0,3*U, MV,-3*U,2*U, ENDL
g_M:  FCB DR,6*U,0, DR,-3*U,2*U, DR,3*U,2*U, DR,-6*U,0, MV,0,U, ENDL
g_SP: FCB MV,0,5*U, ENDL

           INCLUDE "tables.inc"

; ------------------------------------------------------------- vectors ----
           ORG $FFF0
           FDB reset, reset, reset, reset, reset, reset, reset, reset
