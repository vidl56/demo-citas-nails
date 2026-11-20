import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc, updateDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Configuración de Firebase: reemplaza con las credenciales de tu proyecto (citas-nails-prod)
const firebaseConfig = {
    apiKey: "TU_API_KEY",
    authDomain: "TU_PROYECTO.firebaseapp.com",
    projectId: "TU_PROYECTO",
    storageBucket: "TU_PROYECTO.firebasestorage.app",
    messagingSenderId: "TU_SENDER_ID",
    appId: "TU_APP_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Estado sincronizado en tiempo real con Firestore
const AppState = {
    horasBase: ['09:00 AM', '11:00 AM', '02:00 PM', '04:00 PM'],
    disponibilidad: {},
    citas: [],
    pin: '1234',
    listeners: []
};

export function onDataReady(callback) {
    AppState.listeners.push(callback);
}

function notifyListeners() {
    AppState.listeners.forEach(cb => cb());
}

function initRealtimeSync() {
    // 1. Escuchar configuración general (horas base y PIN)
    onSnapshot(doc(db, "config", "general"), (snap) => {
        if (snap.exists()) {
            const data = snap.data();
            if (data.horasBase) AppState.horasBase = data.horasBase;
            if (data.pin) AppState.pin = String(data.pin);
        }
        notifyListeners();
    });

    // 2. Escuchar disponibilidad de días
    onSnapshot(collection(db, "disponibilidad"), (snapshot) => {
        const disp = {};
        snapshot.forEach(docSnap => {
            disp[docSnap.id] = docSnap.data().horas || [];
        });
        AppState.disponibilidad = disp;
        notifyListeners();
    });

    // 3. Escuchar citas en vivo
    onSnapshot(collection(db, "citas"), (snapshot) => {
        const lista = [];
        snapshot.forEach(docSnap => {
            lista.push({ id: docSnap.id, ...docSnap.data() });
        });
        lista.sort((a, b) => `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`));
        AppState.citas = lista;
        notifyListeners();
    });
}

initRealtimeSync();

// Utilidad para fecha local en formato YYYY-MM-DD
export function getTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const Storage = {
    // --- Autenticación y PIN ---
    checkPin(inputPin) {
        if (String(inputPin) === String(AppState.pin)) {
            sessionStorage.setItem('manicura_auth', 'true');
            return true;
        }
        return false;
    },
    isAuthenticated() {
        return sessionStorage.getItem('manicura_auth') === 'true';
    },
    logout() {
        sessionStorage.removeItem('manicura_auth');
        window.location.reload();
    },
    async savePin(newPin) {
        AppState.pin = String(newPin);
        await setDoc(doc(db, "config", "general"), { pin: String(newPin), horasBase: AppState.horasBase }, { merge: true });
    },

    // --- Horarios Base y Disponibilidad ---
    getCustomBaseHours() {
        return AppState.horasBase;
    },
    async saveCustomBaseHours(hoursArray) {
        AppState.horasBase = hoursArray;
        await setDoc(doc(db, "config", "general"), { horasBase: hoursArray, pin: AppState.pin }, { merge: true });
    },
    getHours(dateStr) {
        return AppState.disponibilidad[dateStr] || [];
    },
    async saveHours(dateStr, hoursArray) {
        AppState.disponibilidad[dateStr] = hoursArray;
        await setDoc(doc(db, "disponibilidad", dateStr), { horas: hoursArray });
    },
    // Aplica el mismo horario a 7 días seguidos desde la fecha elegida
    async applyHoursToWeek(startDateStr, hoursArray) {
        const [y, m, d] = startDateStr.split('-').map(Number);
        const baseDate = new Date(y, m - 1, d);
        const promises = [];

        for (let i = 0; i < 7; i++) {
            const target = new Date(baseDate);
            target.setDate(baseDate.getDate() + i);
            const dateStr = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
            AppState.disponibilidad[dateStr] = [...hoursArray];
            promises.push(setDoc(doc(db, "disponibilidad", dateStr), { horas: [...hoursArray] }));
        }
        await Promise.all(promises);
    },

    // --- Citas (Clientas y Manuales) ---
    getAppointments() {
        return AppState.citas;
    },
    // Reserva pública desde index.html (valida disponibilidad)
    async saveAppointment(cita) {
        const docRef = doc(db, "disponibilidad", cita.fecha);
        const snap = await getDoc(docRef);
        const horasActuales = snap.exists() ? (snap.data().horas || []) : [];

        if (!horasActuales.includes(cita.hora)) {
            throw new Error("HORA_OCUPADA");
        }

        await addDoc(collection(db, "citas"), {
            ...cita,
            notaPrivada: '',
            estado: 'pendiente',
            reagendada: false,
            creadoEn: new Date().toISOString()
        });

        const nuevasHoras = horasActuales.filter(h => h !== cita.hora);
        await setDoc(docRef, { horas: nuevasHoras });
    },
    // Reserva manual desde admin.html (permite agendar a cualquier hora y bloquea si estaba abierta)
    async saveManualAppointment(cita) {
        await addDoc(collection(db, "citas"), {
            ...cita,
            estado: 'pendiente',
            reagendada: false,
            creadoPor: 'duena',
            creadoEn: new Date().toISOString()
        });

        const docRef = doc(db, "disponibilidad", cita.fecha);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
            const horasActuales = snap.data().horas || [];
            if (horasActuales.includes(cita.hora)) {
                await setDoc(docRef, { horas: horasActuales.filter(h => h !== cita.hora) });
            }
        }
    },
    async rescheduleAppointment(id, nuevaFecha, nuevaHora, liberarHoraAnterior = true) {
        const citaAntigua = AppState.citas.find(c => c.id === id);
        if (!citaAntigua) return false;

        if (liberarHoraAnterior) {
            const horasVieja = [...this.getHours(citaAntigua.fecha)];
            if (!horasVieja.includes(citaAntigua.hora)) {
                horasVieja.push(citaAntigua.hora);
                await this.saveHours(citaAntigua.fecha, horasVieja);
            }
        }

        const horasNueva = this.getHours(nuevaFecha).filter(h => h !== nuevaHora);
        await this.saveHours(nuevaFecha, horasNueva);

        await updateDoc(doc(db, "citas", id), {
            fechaAnterior: citaAntigua.fecha,
            horaAnterior: citaAntigua.hora,
            fecha: nuevaFecha,
            hora: nuevaHora,
            reagendada: true,
            estado: 'pendiente'
        });
        return true;
    },
    async updateAppointmentStatus(id, nuevoEstado) {
        await updateDoc(doc(db, "citas", id), { estado: nuevoEstado });
    },
    async updatePrivateNote(id, notaPrivada) {
        await updateDoc(doc(db, "citas", id), { notaPrivada: notaPrivada.trim() });
    },
    async deleteAppointment(id) {
        await deleteDoc(doc(db, "citas", id));
    },

    // --- Estadísticas y Desglose por Servicio ---
    getStats() {
        const citas = this.getAppointments();
        const hoyStr = getTodayStr();

        const activas = citas.filter(c => c.estado !== 'cancelada');
        const completadas = citas.filter(c => c.estado === 'completada');
        const pendientes = citas.filter(c => c.estado === 'pendiente');
        const citasHoy = activas.filter(c => c.fecha === hoyStr);

        let unas = 0, pies = 0, extensiones = 0;
        activas.forEach(c => {
            const s = (c.servicio || '').toLowerCase();
            if (s.includes('uña')) unas++;
            if (s.includes('pie')) pies++;
            if (s.includes('extensi')) extensiones++;
        });

        return {
            hoy: citasHoy.length,
            pendientes: pendientes.length,
            completadas: completadas.length,
            totalCitas: activas.length,
            servicios: { unas, pies, extensiones }
        };
    },

    // --- Exportación a Excel (.csv) y Respaldo (.json) ---
    exportCSV() {
        const citas = this.getAppointments();
        const headers = ['Fecha', 'Hora', 'Clienta', 'WhatsApp', 'Servicio', 'Estado', 'Nota Clienta', 'Nota Privada'];
        const escape = (val) => `"${String(val || '').replace(/"/g, '""')}"`;

        const rows = citas.map(c => [
            c.fecha, c.hora, c.cliente, c.telefono, c.servicio, c.estado, c.nota || '', c.notaPrivada || ''
        ].map(escape).join(','));

        // BOM \uFEFF para que Excel reconozca tildes y la ñ correctamente
        const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `agenda-clientas-${getTodayStr()}.csv`;
        a.click();
    },
    exportBackup() {
        const backup = {
            horas_base: AppState.horasBase,
            disponibilidad: AppState.disponibilidad,
            citas: AppState.citas,
            fecha_respaldo: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `respaldo-agenda-${getTodayStr()}.json`;
        a.click();
    }
};

export function formatTime12h(time24) {
    if (!time24) return '';
    const [h, m] = time24.split(':');
    let hours = parseInt(h, 10);
    const suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${String(hours).padStart(2, '0')}:${m} ${suffix}`;
}

// Calendario propio (Soporta indicador doble de citas agendadas en modo Admin)
export class CustomCalendar {
    constructor(containerId, onSelectDate, options = {}) {
        this.container = document.getElementById(containerId);
        this.onSelectDate = onSelectDate;
        this.showAppointmentCount = Boolean(options.showAppointmentCount);
        this.currentDate = new Date();
        this.selectedDate = this.formatDate(new Date());
        this.render();
    }

    formatDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    render() {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();
        const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
        
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const todayStr = this.formatDate(new Date());

        // Conteo de citas activas por fecha (solo para vista admin)
        const countByDate = {};
        if (this.showAppointmentCount) {
            Storage.getAppointments().forEach(c => {
                if (c.estado !== 'cancelada') {
                    countByDate[c.fecha] = (countByDate[c.fecha] || 0) + 1;
                }
            });
        }

        let html = `
            <div class="border border-stone-300 rounded-lg p-4 bg-[#E6DFD5]">
                <div class="flex items-center justify-between mb-4">
                    <button type="button" id="prev-month" class="p-1.5 hover:bg-stone-300/60 rounded-md text-stone-800 transition-colors font-bold">&#8592;</button>
                    <span class="font-semibold text-stone-900">${monthNames[month]} ${year}</span>
                    <button type="button" id="next-month" class="p-1.5 hover:bg-stone-300/60 rounded-md text-stone-800 transition-colors font-bold">&#8594;</button>
                </div>
                <div class="grid grid-cols-7 gap-1 text-center text-xs font-semibold text-stone-600 mb-2">
                    <div>Dom</div><div>Lun</div><div>Mar</div><div>Mié</div><div>Jue</div><div>Vie</div><div>Sáb</div>
                </div>
                <div class="grid grid-cols-7 gap-1.5 text-sm">
        `;

        for (let i = 0; i < firstDay; i++) html += `<div></div>`;

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const isPast = dateStr < todayStr;
            const isSelected = dateStr === this.selectedDate;
            const hasHours = Storage.getHours(dateStr).length > 0;
            const bookedCount = countByDate[dateStr] || 0;

            // En modo admin se permite seleccionar días pasados para consultar historial
            const disabledPast = isPast && !this.showAppointmentCount;

            let btnClass = "h-11 w-full rounded-md flex flex-col items-center justify-center transition-colors relative ";
            if (disabledPast) {
                btnClass += "text-stone-400 cursor-not-allowed bg-stone-200/40";
            } else if (isSelected) {
                btnClass += "bg-[#8C3B32] text-[#F5F0EB] font-semibold shadow-sm";
            } else if (isPast) {
                btnClass += "bg-[#E6DFD5] text-stone-500 hover:bg-stone-300/60 cursor-pointer border border-stone-300/40";
            } else {
                btnClass += "bg-[#EFECE6] text-stone-800 hover:bg-stone-300/70 cursor-pointer border border-stone-300/60";
            }

            const dot = (hasHours && !isPast) 
                ? `<span class="w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-[#F5F0EB]' : 'bg-[#8C3B32]'} mt-0.5"></span>` 
                : '';

            const bookedBadge = (this.showAppointmentCount && bookedCount > 0)
                ? `<span class="absolute top-0.5 right-0.5 text-[9px] leading-none font-semibold px-1 py-0.5 rounded ${isSelected ? 'bg-[#F5F0EB] text-[#8C3B32]' : 'bg-stone-800 text-[#F5F0EB]'}">${bookedCount}</span>`
                : '';

            html += `
                <button type="button" class="${btnClass}" data-date="${dateStr}" ${disabledPast ? 'disabled' : ''}>
                    ${bookedBadge}
                    <span class="leading-none">${day}</span>
                    ${dot}
                </button>
            `;
        }

        html += `</div></div>`;
        this.container.innerHTML = html;

        this.container.querySelector('#prev-month').addEventListener('click', () => {
            this.currentDate.setMonth(this.currentDate.getMonth() - 1);
            this.render();
        });
        this.container.querySelector('#next-month').addEventListener('click', () => {
            this.currentDate.setMonth(this.currentDate.getMonth() + 1);
            this.render();
        });

        this.container.querySelectorAll('button[data-date]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.selectedDate = e.currentTarget.getAttribute('data-date');
                this.render();
                this.onSelectDate(this.selectedDate);
            });
        });
    }
}