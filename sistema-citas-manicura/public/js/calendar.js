// Motor de almacenamiento local, horas personalizadas, reagendado y copias de seguridad
const Storage = {
    // 1. Autenticación (PIN por defecto: 1234)
    checkPin(inputPin) {
        const savedPin = localStorage.getItem('manicura_pin') || '1234';
        if (inputPin === savedPin) {
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

    // 2. Plantilla de Horas Base (Personalizable por la dueña)
    getCustomBaseHours() {
        const defaultHours = ['09:00 AM', '11:00 AM', '02:00 PM', '04:00 PM'];
        return JSON.parse(localStorage.getItem('manicura_horas_base') || JSON.stringify(defaultHours));
    },
    saveCustomBaseHours(hoursArray) {
        localStorage.setItem('manicura_horas_base', JSON.stringify(hoursArray));
    },

    // 3. Disponibilidad por Fecha (YYYY-MM-DD)
    getHours(dateStr) {
        const data = JSON.parse(localStorage.getItem('manicura_disponibilidad') || '{}');
        return data[dateStr] || [];
    },
    saveHours(dateStr, hoursArray) {
        const data = JSON.parse(localStorage.getItem('manicura_disponibilidad') || '{}');
        data[dateStr] = hoursArray;
        localStorage.setItem('manicura_disponibilidad', JSON.stringify(data));
    },

    // 4. Gestión de Citas y Reagendamiento
    getAppointments() {
        return JSON.parse(localStorage.getItem('manicura_citas') || '[]');
    },
    saveAppointment(cita) {
        const citas = this.getAppointments();
        citas.push({ 
            ...cita, 
            id: Date.now(), 
            estado: 'pendiente',
            reagendada: false
        });
        localStorage.setItem('manicura_citas', JSON.stringify(citas));

        // Ocupar la hora seleccionada
        const available = this.getHours(cita.fecha).filter(h => h !== cita.hora);
        this.saveHours(cita.fecha, available);
    },
    rescheduleAppointment(id, nuevaFecha, nuevaHora, liberarHoraAnterior = true) {
        const citas = this.getAppointments();
        const index = citas.findIndex(c => c.id === id);
        if (index === -1) return false;

        const citaAntigua = citas[index];

        // 1. Devolver la hora vieja a la disponibilidad si la dueña lo desea
        if (liberarHoraAnterior) {
            const horasViejaFecha = this.getHours(citaAntigua.fecha);
            if (!horasViejaFecha.includes(citaAntigua.hora)) {
                horasViejaFecha.push(citaAntigua.hora);
                this.saveHours(citaAntigua.fecha, horasViejaFecha);
            }
        }

        // 2. Ocupar la hora nueva si estaba en la lista de disponibles
        const horasNuevaFecha = this.getHours(nuevaFecha).filter(h => h !== nuevaHora);
        this.saveHours(nuevaFecha, horasNuevaFecha);

        // 3. Actualizar registro en el historial
        citas[index] = {
            ...citaAntigua,
            fechaAnterior: citaAntigua.fecha,
            horaAnterior: citaAntigua.hora,
            fecha: nuevaFecha,
            hora: nuevaHora,
            reagendada: true,
            estado: 'pendiente'
        };

        localStorage.setItem('manicura_citas', JSON.stringify(citas));
        return true;
    },
    updateAppointmentStatus(id, nuevoEstado) {
        const citas = this.getAppointments().map(c => c.id === id ? { ...c, estado: nuevoEstado } : c);
        localStorage.setItem('manicura_citas', JSON.stringify(citas));
    },
    deleteAppointment(id) {
        const citas = this.getAppointments().filter(c => c.id !== id);
        localStorage.setItem('manicura_citas', JSON.stringify(citas));
    },

    // 5. Estadísticas
    getStats() {
        const citas = this.getAppointments();
        const activas = citas.filter(c => c.estado !== 'cancelada');
        const completadas = citas.filter(c => c.estado === 'completada');
        const pendientes = citas.filter(c => c.estado === 'pendiente');

        return {
            pendientes: pendientes.length,
            completadas: completadas.length,
            ingresosReales: completadas.reduce((sum, c) => sum + Number(c.precio || 0), 0),
            ingresosEstimados: activas.reduce((sum, c) => sum + Number(c.precio || 0), 0)
        };
    },

    // 6. Respaldo Físico (Para no perder datos si se limpia el navegador)
    exportBackup() {
        const backup = {
            horas_base: this.getCustomBaseHours(),
            disponibilidad: JSON.parse(localStorage.getItem('manicura_disponibilidad') || '{}'),
            citas: this.getAppointments(),
            fecha_respaldo: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `respaldo-agenda-nails-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
    },
    importBackup(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            if (data.horas_base) localStorage.setItem('manicura_horas_base', JSON.stringify(data.horas_base));
            if (data.disponibilidad) localStorage.setItem('manicura_disponibilidad', JSON.stringify(data.disponibilidad));
            if (data.citas) localStorage.setItem('manicura_citas', JSON.stringify(data.citas));
            return true;
        } catch (e) {
            return false;
        }
    }
};

// Utilidad para convertir hora militar (input type="time") a formato 12h (Ej. 14:30 -> 02:30 PM)
function formatTime12h(time24) {
    if (!time24) return '';
    const [h, m] = time24.split(':');
    let hours = parseInt(h, 10);
    const suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${String(hours).padStart(2, '0')}:${m} ${suffix}`;
}

// Calendario Visual con paleta cálida (Cero blanco puro, tonos Arena/Taupe)
class CustomCalendar {
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

        for (let i = 0; i < firstDay; i++) {
            html += `<div></div>`;
        }

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