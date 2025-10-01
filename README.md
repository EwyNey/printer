# printer

Usage:
    python timeline_to_html.py input.txt [output.html]

Input format:
    start_us,end_us,thread_id,args[,color]

- start_us, end_us: integers (microseconds)
- thread_id: string (identifies thread id)
- args: string (may contain commas; use quotes in CSV)
- color: optional integer (if present, used to derive color)

Output:
    HTML file with embedded SVG timeline and simple JS controls to collapse/expand threads.












#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
exotic_network_gui_numeric_labels.py

Интерактивный сетевой граф с редактором вершин и рёбер для проекта "Экзотик-Хаус".
Изменение по просьбе: на рёбрах отображается только числовая длительность; в вершинах
отображаются только числа (номер, ранний, поздний, резерв) — без буквенных префиксов.

Запуск: python exotic_network_gui_numeric_labels.py

Зависимости:
  - Python 3.8+
  - matplotlib
  - networkx
  - tkinter (обычно уже установлен)
"""

import json
import tkinter as tk
from tkinter import simpledialog, messagebox, filedialog
from functools import partial

import networkx as nx
import matplotlib
matplotlib.use('TkAgg')
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure
from matplotlib.patches import Circle
from matplotlib.lines import Line2D

# === Исходные данные ===
initial_nodes = {
    1:  {'n':1,  'early':0,  'late':0,  'r':0,  'pos':(100,100)},
    2:  {'n':2,  'early':10, 'late':10, 'r':0,  'pos':(260,100)},
    3:  {'n':3,  'early':24, 'late':24, 'r':0,  'pos':(420,60)},
    4:  {'n':4,  'early':17, 'late':24, 'r':7,  'pos':(420,140)},
    5:  {'n':5,  'early':31, 'late':48, 'r':17, 'pos':(420,220)},
    6:  {'n':6,  'early':38, 'late':38, 'r':0,  'pos':(580,100)},
    7:  {'n':7,  'early':45, 'late':45, 'r':0,  'pos':(740,100)},
    8:  {'n':8,  'early':20, 'late':30, 'r':10, 'pos':(260,220)},
    9:  {'n':9,  'early':25, 'late':35, 'r':10, 'pos':(380,300)},
    10: {'n':10, 'early':24, 'late':33, 'r':9,  'pos':(140,300)},
    11: {'n':11, 'early':31, 'late':40, 'r':9,  'pos':(260,360)},
    12: {'n':12, 'early':41, 'late':50, 'r':9,  'pos':(380,420)},
    13: {'n':13, 'early':24, 'late':40, 'r':16, 'pos':(140,180)},
    14: {'n':14, 'early':34, 'late':50, 'r':16, 'pos':(260,140)},
    15: {'n':15, 'early':48, 'late':48, 'r':0,  'pos':(900,100)},
    16: {'n':16, 'early':44, 'late':53, 'r':9,  'pos':(740,220)},
    17: {'n':17, 'early':53, 'late':53, 'r':0,  'pos':(980,160)},
    18: {'n':18, 'early':54, 'late':54, 'r':0,  'pos':(1100,160)}
}

initial_links = [
  (1,2,'A',10, True),
  (2,3,'B',14, True),
  (2,4,'C',7, False),
  (2,5,'D',21, False),
  (3,6,'E',14, True),
  (4,6,'F',14, False),
  (6,7,'G',7, True),
  (1,8,'H',10, False),
  (8,9,'I',5, False),
  (1,10,'J',14, False),
  (10,11,'K',7, False),
  (11,12,'L',10, False),
  (1,13,'M',14, False),
  (13,14,'N',10, False),
  (7,15,'O',3, True),
  (14,16,'P(N->16)',3, False),
  (11,16,'P(L->16)',3, False),
  (5,17,'Q(D->17)',5, False),
  (15,17,'Q(O->17)',5, True),
  (16,18,'R(P->18)',1, False),
  (17,18,'R(Q->18)',1, True),
]

NODE_R = 36  # радиус вершины (пиксели)

# === Глобальные объекты состояния ===
G = nx.DiGraph()
nodes_data = {}   # id -> dict (n, early, late, r, pos)
edge_list = []    # (s,t,label,dur,crit)
next_node_id = 1

# === Инициализация графа из исходных данных ===
def reset_to_initial():
    global G, nodes_data, edge_list, next_node_id
    G = nx.DiGraph()
    nodes_data = {k: dict(v) for k,v in initial_nodes.items()}
    edge_list = [tuple(l) for l in initial_links]
    for nid,attrs in nodes_data.items():
        G.add_node(nid, **attrs)
    for s,t,label,dur,crit in edge_list:
        G.add_edge(s,t, label=label, dur=dur, crit=crit)
    next_node_id = max(nodes_data.keys()) + 1

reset_to_initial()

# === GUI ===
class NetworkEditorApp:
    def __init__(self, root):
        self.root = root
        root.title("Сетевой граф — Экзотик-Хаус (редактор, числовые метки)")
        # === layout: left: matplotlib canvas; right: controls ===
        self.frame_left = tk.Frame(root)
        self.frame_left.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.frame_right = tk.Frame(root, width=320)
        self.frame_right.pack(side=tk.RIGHT, fill=tk.Y)

        # matplotlib figure
        self.fig = Figure(figsize=(10,7))
        self.ax = self.fig.add_subplot(111)
        self.ax.set_aspect('equal')
        self.ax.axis('off')
        self.ax.set_title('Перетащите вершины мышью. Двойной клик по фону сбрасывает подсветку.')

        self.canvas = FigureCanvasTkAgg(self.fig, master=self.frame_left)
        self.canvas_widget = self.canvas.get_tk_widget()
        self.canvas_widget.pack(fill=tk.BOTH, expand=True)

        # Lists and buttons on right panel
        tk.Label(self.frame_right, text="Вершины", font=('Arial', 11, 'bold')).pack(pady=(8,0))
        self.node_listbox = tk.Listbox(self.frame_right, height=10)
        self.node_listbox.pack(fill=tk.X, padx=8)
        self.node_listbox.bind('<<ListboxSelect>>', self.on_node_select)

        btn_frame_nodes = tk.Frame(self.frame_right)
        btn_frame_nodes.pack(fill=tk.X, padx=8, pady=4)
        tk.Button(btn_frame_nodes, text="Добавить", command=self.add_node_dialog).pack(side=tk.LEFT, expand=True, fill=tk.X)
        tk.Button(btn_frame_nodes, text="Редактировать", command=self.edit_selected_node).pack(side=tk.LEFT, expand=True, fill=tk.X)
        tk.Button(btn_frame_nodes, text="Удалить", command=self.delete_selected_node).pack(side=tk.LEFT, expand=True, fill=tk.X)

        tk.Label(self.frame_right, text="Рёбра", font=('Arial', 11, 'bold')).pack(pady=(8,0))
        self.edge_listbox = tk.Listbox(self.frame_right, height=10)
        self.edge_listbox.pack(fill=tk.X, padx=8)
        self.edge_listbox.bind('<<ListboxSelect>>', self.on_edge_select)

        btn_frame_edges = tk.Frame(self.frame_right)
        btn_frame_edges.pack(fill=tk.X, padx=8, pady=4)
        tk.Button(btn_frame_edges, text="Добавить", command=self.add_edge_dialog).pack(side=tk.LEFT, expand=True, fill=tk.X)
        tk.Button(btn_frame_edges, text="Редактировать", command=self.edit_selected_edge).pack(side=tk.LEFT, expand=True, fill=tk.X)
        tk.Button(btn_frame_edges, text="Удалить", command=self.delete_selected_edge).pack(side=tk.LEFT, expand=True, fill=tk.X)

        # Save/Load/Reset
        tk.Button(self.frame_right, text="Сохранить в JSON...", command=self.save_to_file).pack(fill=tk.X, padx=8, pady=(12,4))
        tk.Button(self.frame_right, text="Загрузить из JSON...", command=self.load_from_file).pack(fill=tk.X, padx=8)
        tk.Button(self.frame_right, text="Сбросить к исходным", command=self.reset_graph).pack(fill=tk.X, padx=8, pady=(12,4))

        # internal drawing objects
        self.node_artists = {}   # nid -> dict of artists and texts
        self.edge_artists = []   # list of ((s,t), line)
        self.edge_labels = []    # list of ((s,t), text_artist)

        # interactive dragging state
        self.selected = {'nid': None}
        self._dragging = False

        # events
        self.canvas.mpl_connect('button_press_event', self.on_press)
        self.canvas.mpl_connect('button_release_event', self.on_release)
        self.canvas.mpl_connect('motion_notify_event', self.on_motion)
        self.canvas.mpl_connect('button_press_event', self.on_click)

        # initial draw
        self.redraw_all()

    # === helpers ===
    def redraw_all(self):
        # clear axes and re-draw from nodes_data and edge_list
        self.ax.clear()
        self.ax.set_aspect('equal')
        self.ax.axis('off')
        self.ax.set_title('Перетащите вершины мышью. Двойной клик по фону сбрасывает подсветку.')
        self.node_artists.clear()
        self.edge_artists.clear()
        self.edge_labels.clear()

        # set plotting limits based on positions
        xs = [pos[0] for pos in (nd['pos'] for nd in nodes_data.values())]
        ys = [pos[1] for pos in (nd['pos'] for nd in nodes_data.values())]
        if xs and ys:
            minx, maxx = min(xs)-100, max(xs)+100
            miny, maxy = min(ys)-100, max(ys)+100
            self.ax.set_xlim(minx, maxx)
            self.ax.set_ylim(maxy, miny)  # invert y axis

        # draw edges first (so they are under nodes)
        for edge in edge_list:
            s,t,label,dur,crit = edge
            if s not in nodes_data or t not in nodes_data:
                continue
            x1,y1 = nodes_data[s]['pos']
            x2,y2 = nodes_data[t]['pos']
            color = 'red' if crit else '#666666'
            lw = 2.6 if crit else 1.8
            line = Line2D([x1,x2],[y1,y2], linewidth=lw, color=color, zorder=1, solid_capstyle='round')
            self.ax.add_line(line)
            self.edge_artists.append(((s,t), line))
            # **Здесь**: отображаем только числовую длительность (dur) без букв
            mx,my = (x1+x2)/2, (y1+y2)/2
            txt = self.ax.text(mx, my, f"{int(dur)}", fontsize=9, ha='center', va='center', zorder=2,
                               bbox=dict(boxstyle='round,pad=0.2', fc='white', ec='none', alpha=0.8))
            self.edge_labels.append(((s,t), txt))

        # draw nodes
        for nid, nd in nodes_data.items():
            art = self._draw_node(nid, nd['pos'], nd)
            self.node_artists[nid] = art

        # populate listboxes
        self.refresh_listboxes()

        self.canvas.draw_idle()

    def _draw_node(self, nid, pos, nd):
        x,y = pos
        c = Circle((x,y), NODE_R, facecolor='white', edgecolor='k', linewidth=2, zorder=3)
        self.ax.add_patch(c)
        # X diagonals
        diag1 = Line2D([x-NODE_R, x+NODE_R], [y-NODE_R, y+NODE_R], linewidth=1.4, color='k', zorder=4)
        diag2 = Line2D([x-NODE_R, x+NODE_R], [y+NODE_R, y-NODE_R], linewidth=1.4, color='k', zorder=4)
        self.ax.add_line(diag1); self.ax.add_line(diag2)
        # vertical & horizontal
        vert = Line2D([x,x],[y-NODE_R,y+NODE_R], linewidth=1.0, color='k', zorder=4)
        hor = Line2D([x-NODE_R,x+NODE_R],[y,y], linewidth=1.0, color='k', zorder=4)
        self.ax.add_line(vert); self.ax.add_line(hor)

        # **Здесь**: отображаем ТОЛЬКО числа — без буквенных префиксов
        t_top = self.ax.text(x, y - NODE_R + 12, str(nd['n']), ha='center', va='center', zorder=5, fontsize=11, fontweight='bold')
        t_left = self.ax.text(x - NODE_R + 6, y + 4, f"{int(nd['early'])}", ha='left', va='center', zorder=5, fontsize=9)
        t_right = self.ax.text(x + NODE_R - 6, y + 4, f"{int(nd['late'])}", ha='right', va='center', zorder=5, fontsize=9)
        t_bot = self.ax.text(x, y + NODE_R - 8, f"{int(nd['r'])}", ha='center', va='center', zorder=5, fontsize=9)

        return {'circle': c, 'diag1': diag1, 'diag2': diag2, 'vert': vert, 'hor': hor,
                't_top': t_top, 't_left': t_left, 't_right': t_right, 't_bot': t_bot}

    def refresh_listboxes(self):
        # nodes listbox: показываем только числа, разделённые запятыми (без букв)
        self.node_listbox.delete(0, tk.END)
        for nid in sorted(nodes_data.keys()):
            nd = nodes_data[nid]
            self.node_listbox.insert(tk.END, f"{nid}: {nd['n']}, {nd['early']}, {nd['late']}, {nd['r']}")
        # edges listbox: показываем индекс, стрелку, длительность (число), пометка крита
        self.edge_listbox.delete(0, tk.END)
        for idx,(s,t,label,dur,crit) in enumerate(edge_list):
            self.edge_listbox.insert(tk.END, f"{idx+1}: {s}→{t}  {int(dur)}{' CRIT' if crit else ''}")

    # === Event handlers for matplotlib interactions (dragging, clicking) ===
    def on_press(self, event):
        if event.inaxes != self.ax:
            return
        # find node under click
        for nid, parts in self.node_artists.items():
            circ = parts['circle']
            cx, cy = circ.center
            dx = event.xdata - cx
            dy = event.ydata - cy
            if dx*dx + dy*dy <= NODE_R*NODE_R:
                self.selected['nid'] = nid
                circ.set_zorder(10)
                for a in parts.values():
                    if hasattr(a, 'set_zorder'):
                        a.set_zorder(10)
                self._dragging = True
                return
        # click on background
        if event.dblclick:
            # double click -> reset edge styles
            for (_,line) in self.edge_artists:
                line.set_alpha(1.0); line.set_linewidth(2 if line.get_color()=='red' else 1.8)
            self.canvas.draw_idle()

    def on_release(self, event):
        self._dragging = False
        self.selected['nid'] = None

    def on_motion(self, event):
        if not self._dragging or self.selected['nid'] is None or event.inaxes != self.ax:
            return
        nid = self.selected['nid']
        x, y = event.xdata, event.ydata
        if x is None or y is None:
            return
        nodes_data[nid]['pos'] = (x,y)
        parts = self.node_artists[nid]
        parts['circle'].center = (x,y)
        parts['diag1'].set_data([x-NODE_R, x+NODE_R], [y-NODE_R, y+NODE_R])
        parts['diag2'].set_data([x-NODE_R, x+NODE_R], [y+NODE_R, y-NODE_R])
        parts['vert'].set_data([x, x], [y-NODE_R, y+NODE_R])
        parts['hor'].set_data([x-NODE_R, x+NODE_R], [y, y])
        parts['t_top'].set_position((x, y - NODE_R + 12))
        parts['t_left'].set_position((x - NODE_R + 6, y + 4))
        parts['t_right'].set_position((x + NODE_R - 6, y + 4))
        parts['t_bot'].set_position((x, y + NODE_R - 8))

        # update edges connected
        for (s,t), line in self.edge_artists:
            if s==nid or t==nid:
                x1,y1 = nodes_data[s]['pos']
                x2,y2 = nodes_data[t]['pos']
                line.set_data([x1,x2],[y1,y2])
        for (s,t), lbl in self.edge_labels:
            x1,y1 = nodes_data[s]['pos']; x2,y2 = nodes_data[t]['pos']
            mx,my = (x1+x2)/2,(y1+y2)/2
            lbl.set_position((mx, my))
        self.canvas.draw_idle()

    def on_click(self, event):
        # also used for selecting nodes to highlight edges
        if event.inaxes != self.ax:
            return
        # find node
        for nid, parts in self.node_artists.items():
            cx, cy = parts['circle'].center
            dx = event.xdata - cx
            dy = event.ydata - cy
            if dx*dx + dy*dy <= NODE_R*NODE_R:
                # highlight incident edges
                for (s,t), line in self.edge_artists:
                    if s==nid or t==nid:
                        line.set_alpha(1.0); line.set_linewidth(3.0)
                    else:
                        line.set_alpha(0.15)
                self.canvas.draw_idle()
                return

    # === Node operations ===
    def add_node_dialog(self):
        global next_node_id
        dialog = NodeEditDialog(self.root, title="Добавить вершину", nid=None)
        if dialog.result is None:
            return
        new_n = next_node_id
        next_node_id += 1
        nodes_data[new_n] = {
            'n': dialog.result['n'],
            'early': dialog.result['early'],
            'late': dialog.result['late'],
            'r': dialog.result['r'],
            'pos': dialog.result.get('pos', (200,200))
        }
        G.add_node(new_n, **nodes_data[new_n])
        self.redraw_all()

    def edit_selected_node(self):
        sel = self.node_listbox.curselection()
        if not sel:
            messagebox.showinfo("Инфо", "Выберите вершину в списке слева.")
            return
        idx = sel[0]
        nid = sorted(nodes_data.keys())[idx]
        dialog = NodeEditDialog(self.root, title=f"Редактировать вершину {nid}", nid=nid, data=nodes_data[nid])
        if dialog.result is None:
            return
        nodes_data[nid]['n'] = dialog.result['n']
        nodes_data[nid]['early'] = dialog.result['early']
        nodes_data[nid]['late'] = dialog.result['late']
        nodes_data[nid]['r'] = dialog.result['r']
        # position may be edited
        if 'pos' in dialog.result:
            nodes_data[nid]['pos'] = dialog.result['pos']
        self.redraw_all()

    def delete_selected_node(self):
        sel = self.node_listbox.curselection()
        if not sel:
            messagebox.showinfo("Инфо", "Выберите вершину в списке слева.")
            return
        idx = sel[0]
        nid = sorted(nodes_data.keys())[idx]
        if not messagebox.askyesno("Подтвердите", f"Удалить вершину {nid} и все связанные рёбра?"):
            return
        # remove node and related edges
        nodes_data.pop(nid)
        # remove edges referencing nid
        global edge_list
        edge_list = [e for e in edge_list if e[0]!=nid and e[1]!=nid]
        self.redraw_all()

    # === Edge operations ===
    def add_edge_dialog(self):
        dialog = EdgeEditDialog(self.root, title="Добавить ребро", nodes_keys=sorted(nodes_data.keys()))
        if dialog.result is None:
            return
        s = dialog.result['s']; t = dialog.result['t']
        label = dialog.result['label']; dur = dialog.result['dur']; crit = dialog.result['crit']
        edge_list.append((s,t,label,dur,crit))
        self.redraw_all()

    def edit_selected_edge(self):
        sel = self.edge_listbox.curselection()
        if not sel:
            messagebox.showinfo("Инфо", "Выберите ребро в списке слева.")
            return
        idx = sel[0]
        if idx < 0 or idx >= len(edge_list):
            return
        s,t,label,dur,crit = edge_list[idx]
        dialog = EdgeEditDialog(self.root, title="Редактировать ребро", nodes_keys=sorted(nodes_data.keys()),
                                initial={'s':s,'t':t,'label':label,'dur':dur,'crit':crit})
        if dialog.result is None:
            return
        edge_list[idx] = (dialog.result['s'], dialog.result['t'], dialog.result['label'], dialog.result['dur'], dialog.result['crit'])
        self.redraw_all()

    def delete_selected_edge(self):
        sel = self.edge_listbox.curselection()
        if not sel:
            messagebox.showinfo("Инфо", "Выберите ребро в списке слева.")
            return
        idx = sel[0]
        if not messagebox.askyesno("Подтвердите", f"Удалить ребро #{idx+1}?"):
            return
        edge_list.pop(idx)
        self.redraw_all()

    def on_node_select(self, event):
        # highlight selected node in plot
        sel = self.node_listbox.curselection()
        if not sel:
            return
        idx = sel[0]
        nid = sorted(nodes_data.keys())[idx]
        # center view? just highlight edges
        for (s,t), line in self.edge_artists:
            if s==nid or t==nid:
                line.set_alpha(1.0); line.set_linewidth(3.0)
            else:
                line.set_alpha(0.15)
        self.canvas.draw_idle()

    def on_edge_select(self, event):
        sel = self.edge_listbox.curselection()
        if not sel:
            return
        idx = sel[0]
        # highlight that edge
        for i,((s,t), line) in enumerate(self.edge_artists):
            if i==idx:
                line.set_alpha(1.0); line.set_linewidth(3.0)
            else:
                line.set_alpha(0.15)
        self.canvas.draw_idle()

    # === Save / Load / Reset ===
    def save_to_file(self):
        path = filedialog.asksaveasfilename(defaultextension=".json", filetypes=[("JSON files","*.json")])
        if not path:
            return
        data = {'nodes': nodes_data, 'edges': edge_list}
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        messagebox.showinfo("Готово", f"Сохранено в {path}")

    def load_from_file(self):
        path = filedialog.askopenfilename(filetypes=[("JSON files","*.json")])
        if not path:
            return
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            # validate
            nodes = data.get('nodes', {})
            edges = data.get('edges', [])
            # convert keys to int
            new_nodes = {}
            for k,v in nodes.items():
                nk = int(k) if isinstance(k,str) and k.isdigit() else int(k)
                new_nodes[nk] = v
            # ensure each node has pos
            for nid, nd in new_nodes.items():
                if 'pos' not in nd:
                    nd['pos'] = (100 + nid*20, 100)
            # assign
            global edge_list, nodes_data, next_node_id
            nodes_data = new_nodes
            edge_list = [tuple(e) for e in edges]
            if nodes_data:
                next_node_id = max(nodes_data.keys()) + 1
            else:
                next_node_id = 1
            self.redraw_all()
            messagebox.showinfo("Готово", f"Загружено из {path}")
        except Exception as e:
            messagebox.showerror("Ошибка", f"Не удалось загрузить: {e}")

    def reset_graph(self):
        if not messagebox.askyesno("Подтвердите", "Сбросить граф к исходным данным?"):
            return
        reset_to_initial()
        self.redraw_all()

# === Dialogs for node and edge editing ===
class NodeEditDialog(simpledialog.Dialog):
    def __init__(self, parent, title=None, nid=None, data=None):
        self.nid = nid
        self.data = data
        super().__init__(parent, title=title)

    def body(self, master):
        tk.Label(master, text="Номер вершины (№):").grid(row=0, column=0, sticky='w')
        self.entry_n = tk.Entry(master)
        self.entry_n.grid(row=0, column=1)
        tk.Label(master, text="Ранний срок (E):").grid(row=1, column=0, sticky='w')
        self.entry_early = tk.Entry(master)
        self.entry_early.grid(row=1, column=1)
        tk.Label(master, text="Поздний срок (L):").grid(row=2, column=0, sticky='w')
        self.entry_late = tk.Entry(master)
        self.entry_late.grid(row=2, column=1)
        tk.Label(master, text="Резерв (R):").grid(row=3, column=0, sticky='w')
        self.entry_r = tk.Entry(master)
        self.entry_r.grid(row=3, column=1)
        tk.Label(master, text="Позиция X,Y (необязательно):").grid(row=4, column=0, sticky='w')
        self.entry_pos = tk.Entry(master)
        self.entry_pos.grid(row=4, column=1)

        if self.data:
            self.entry_n.insert(0, str(self.data.get('n', '')))
            self.entry_early.insert(0, str(self.data.get('early', '')))
            self.entry_late.insert(0, str(self.data.get('late', '')))
            self.entry_r.insert(0, str(self.data.get('r', '')))
            pos = self.data.get('pos')
            if pos:
                self.entry_pos.insert(0, f"{pos[0]},{pos[1]}")
        else:
            # defaults
            self.entry_n.insert(0, "0")
            self.entry_early.insert(0, "0")
            self.entry_late.insert(0, "0")
            self.entry_r.insert(0, "0")

        return self.entry_n

    def validate(self):
        try:
            n = int(self.entry_n.get())
            early = int(self.entry_early.get())
            late = int(self.entry_late.get())
            r = int(self.entry_r.get())
            pos_text = self.entry_pos.get().strip()
            pos = None
            if pos_text:
                parts = pos_text.split(',')
                if len(parts) == 2:
                    pos = (float(parts[0].strip()), float(parts[1].strip()))
                else:
                    messagebox.showerror("Ошибка", "Позиция должна быть в формате X,Y")
                    return False
            self._result = {'n':n, 'early':early, 'late':late, 'r':r}
            if pos is not None:
                self._result['pos'] = pos
            return True
        except Exception as e:
            messagebox.showerror("Ошибка", f"Неверные данные: {e}")
            return False

    def apply(self):
        self.result = self._result

class EdgeEditDialog(simpledialog.Dialog):
    def __init__(self, parent, title=None, nodes_keys=None, initial=None):
        self.nodes_keys = nodes_keys or []
        self.initial = initial or {}
        super().__init__(parent, title=title)

    def body(self, master):
        tk.Label(master, text="От (node id):").grid(row=0, column=0, sticky='w')
        self.var_s = tk.StringVar(master)
        s0 = str(self.initial.get('s', self.nodes_keys[0] if self.nodes_keys else ''))
        self.var_s.set(s0)
        self.opt_s = tk.OptionMenu(master, self.var_s, *[str(k) for k in self.nodes_keys])
        self.opt_s.grid(row=0, column=1, sticky='ew')

        tk.Label(master, text="К (node id):").grid(row=1, column=0, sticky='w')
        self.var_t = tk.StringVar(master)
        t0 = str(self.initial.get('t', self.nodes_keys[0] if self.nodes_keys else ''))
        self.var_t.set(t0)
        self.opt_t = tk.OptionMenu(master, self.var_t, *[str(k) for k in self.nodes_keys])
        self.opt_t.grid(row=1, column=1, sticky='ew')

        tk.Label(master, text="Код (label, опционально):").grid(row=2, column=0, sticky='w')
        self.entry_label = tk.Entry(master)
        self.entry_label.grid(row=2, column=1)
        tk.Label(master, text="Длительность (дн):").grid(row=3, column=0, sticky='w')
        self.entry_dur = tk.Entry(master)
        self.entry_dur.grid(row=3, column=1)
        self.var_crit = tk.BooleanVar(master)
        self.chk_crit = tk.Checkbutton(master, text="Критическое ребро", variable=self.var_crit)
        self.chk_crit.grid(row=4, columnspan=2, sticky='w')

        if self.initial:
            self.entry_label.insert(0, str(self.initial.get('label','')))
            self.entry_dur.insert(0, str(self.initial.get('dur', '')))
            self.var_crit.set(bool(self.initial.get('crit', False)))

        return self.opt_s

    def validate(self):
        try:
            s = int(self.var_s.get())
            t = int(self.var_t.get())
            if s==t:
                if not messagebox.askyesno("Предупреждение", "Источник и цель совпадают. Продолжить?"):
                    return False
            label = self.entry_label.get().strip()
            dur = int(self.entry_dur.get())
            crit = bool(self.var_crit.get())
            self._result = {'s':s,'t':t,'label':label,'dur':dur,'crit':crit}
            return True
        except Exception as e:
            messagebox.showerror("Ошибка", f"Неверные данные: {e}")
            return False

    def apply(self):
        self.result = self._result

# === Запуск приложения ===
def main():
    root = tk.Tk()
    app = NetworkEditorApp(root)
    root.geometry('1280x820')
    root.mainloop()

if __name__ == '__main__':
    main()


