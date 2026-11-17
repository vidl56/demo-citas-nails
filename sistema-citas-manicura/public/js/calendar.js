import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc, updateDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Configuración real de tu proyecto citas-nails-prod
const firebaseConfig = {
    apiKey: "AIzaSyBfhdrYi7Kvc6u--PP1-A4VGK8zmD4E_YU",
    authDomain: "citas-nails-prod.firebaseapp.com",
    projectId: "citas-nails-prod",
    storageBucket: "citas-nails-prod.firebasestorage.app",
    messagingSenderId: "705585538747",
    appId: "1:705585538747:web:78da577bf4e95f5217ab9e"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Estado sincronizado en tiempo real entre todos los dispositivos
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
    // 1. Escuchar horas base y PIN
    onSnapshot(doc(db, "config", "general"), (snap) => {
        if (snap.exists()) {
            const data = snap.data();
            if (data.horasBase) AppState.horasBase = data.horasBase;
            if (data.pin) AppState.pin = data.pin;
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

export const Storage = {
    checkPin(inputPin) {
        if (inputPin === AppState.pin) {
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

    getAppointments() {
        return AppState.citas;
    },
    async saveAppointment(cita) {
        const docRef = doc(db, "disponibilidad", cita.fecha);
        const snap = await getDoc(docRef);
        const horasActuales = snap.exists() ? (snap.data().horas || []) : [];

        if (!horasActuales.includes(cita.hora)) {
            throw new Error("HORA_OCUPADA");
        }

        await addDoc(collection(db, "citas"), {
            ...cita,
            estado: 'pendiente',
            reagendada: false,
            creadoEn: new Date().toISOString()
        });

        const nuevasHoras = horasActuales.filter(h => h !== cita.hora);
        await setDoc(docRef, { horas: nuevasHoras });
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
    async deleteAppointment(id) {
        await deleteDoc(doc(db, "citas", id));
    },

    getStats() {
        const citas = this.getAppointments();
        const y = new Date().getFullYear();
        const m = String(new Date().getMonth() + 1).padStart(2, '0');
        const d = String(new Date().getDate()).padStart(2, '0');
        const hoyStr = `${y}-${m}-${d}`;

        const activas = citas.filter(c => c.estado !== 'cancelada');
        const completadas = citas.filter(c => c.estado === 'completada');
        const pendientes = citas.filter(c => c.estado === 'pendiente');
        const citasHoy = activas.filter(c => c.fecha === hoyStr);

        return {
            hoy: citasHoy.length,
            pendientes: pendientes.length,
            completadas: completadas.length,
            totalCitas: activas.length
        };
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
        a.download = `respaldo-agenda-nails-${new Date().toISOString().split('T')[0]}.json`;
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

export class CustomCalendar {
    constructor(containerId, onSelectDate) {
        this.container = document.getElementById(containerId);
        this.onSelectDate = onSelectDate;
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

            let btnClass = "h-10 w-full rounded-md flex flex-col items-center justify-center transition-colors relative ";
            if (isPast) {
                btnClass += "text-stone-400 cursor-not-allowed bg-stone-200/40";
            } else if (isSelected) {
                btnClass += "bg-[#8C3B32] text-[#F5F0EB] font-semibold shadow-sm";
            } else {
                btnClass += "bg-[#EFECE6] text-stone-800 hover:bg-stone-300/70 cursor-pointer border border-stone-300/60";
            }

            const dot = (hasHours && !isPast) 
                ? `<span class="w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-[#F5F0EB]' : 'bg-[#8C3B32]'} mt-0.5"></span>` 
                : '';

            html += `
                <button type="button" class="${btnClass}" data-date="${dateStr}" ${isPast ? 'disabled' : ''}>
                    <span>${day}</span>
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