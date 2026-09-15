<template>
  <BaseLayout>
    <!-- ── Top Navigation ── -->
    <TopNav :items="topNavItems" />

    <div class="content-container">
      <!-- ── Main Tabs ── -->
      <nav class="main-nav">
        <div class="nav-links">
          <a v-for="item in navItems" :key="item.id" href="#"
            :class="['nav-item', { active: activeNavItem === item.id }]" @click.prevent="handleNavClick(item.id)">
            {{ item.name }}
            <span v-if="getRoomCount(item.id) > 0" class="room-count">
              ({{ getRoomCount(item.id) }})
            </span>
          </a>
        </div>
      </nav>

      <!-- ── Floor Filter ── -->
      <div class="floor-filter">
        <button v-for="floor in floorsFilterOptions" :key="floor" :class="['floor-btn', { active: selectedFloor === floor }]"
          @click="selectedFloor = floor">
          {{ floor === 'all' ? 'All Room' : floor === 'blockRelease' ? 'Block / Release' : `Floor ${floor}` }}
        </button>
      </div>

      <!-- ── Block / Release Panel (เฉพาะ Out of Order) ธีมแบบ CustomerNameComponent ── -->
      <div v-if="activeNavItem === 'outOfOrder' && selectedFloor === 'blockRelease'" class="block-release-panel">
        <div class="block-release-config-card">
          <div class="block-release-card-header">
            <h2 class="block-release-card-title">
              <i class="fas fa-lock"></i>
              Block / Release
            </h2>
            <div class="block-release-tabs">
              <button :class="['block-release-tab', { active: blockReleaseTab === 'block' }]" @click="blockReleaseTab = 'block'">Block</button>
              <button :class="['block-release-tab', { active: blockReleaseTab === 'release' }]" @click="blockReleaseTab = 'release'">Release</button>
            </div>
          </div>

          <div class="block-release-card-content">
            <div class="block-release-form-section">
              <div class="block-release-form-group">
                <label>Type</label>
                <select v-model="blockReleaseType" class="block-release-form-select">
                  <option value="Room">Room</option>
                  <option value="Floor">Floor</option>
                </select>
              </div>

              <!-- ฟอร์ม Room -->
              <template v-if="blockReleaseType === 'Room'">
                <div class="block-release-form-row">
                  <div class="block-release-form-group">
                    <label>Room No.</label>
                    <input v-model="blockReleaseForm.roomNo" type="text" class="block-release-form-input" placeholder="">
                  </div>
                </div>
                <div v-if="blockReleaseTab === 'block'" class="block-release-form-row">
                  <div class="block-release-form-group">
                    <label>Begin Date</label>
                    <input v-model="blockReleaseForm.beginDate" type="date" class="block-release-form-input">
                  </div>
                  <div class="block-release-form-group">
                    <label>End Date</label>
                    <input v-model="blockReleaseForm.endDate" type="date" class="block-release-form-input">
                  </div>
                </div>
                <div class="block-release-form-group">
                  <label>Reference <span class="block-release-required">*</span></label>
                  <input v-model="blockReleaseForm.reference" type="text" class="block-release-form-input" placeholder="" required>
                </div>
              </template>

              <!-- ฟอร์ม Floor -->
              <template v-if="blockReleaseType === 'Floor'">
                <div class="block-release-form-row">
                  <div class="block-release-form-group">
                    <label>Floor No.</label>
                    <input v-model="blockReleaseForm.floorNo" type="text" class="block-release-form-input" placeholder="">
                  </div>
                  <!-- Building No. เฉพาะ Block (Release Floor ไม่ส่ง) -->
                  <div v-if="blockReleaseTab === 'block'" class="block-release-form-group">
                    <label>Building No.</label>
                    <select v-model="blockReleaseForm.buildingNo" class="block-release-form-select">
                      <option value="">-- เลือก --</option>
                      <option v-for="b in buildingList" :key="b.RmCateCode" :value="b.RmCateCode">{{ b.RmCateName }}</option>
                    </select>
                  </div>
                </div>
                <!-- Begin Date / End Date เฉพาะ Block (Release Floor ไม่ส่ง) -->
                <div v-if="blockReleaseTab === 'block'" class="block-release-form-row">
                  <div class="block-release-form-group">
                    <label>Begin Date</label>
                    <input v-model="blockReleaseForm.beginDate" type="date" class="block-release-form-input">
                  </div>
                  <div class="block-release-form-group">
                    <label>End Date</label>
                    <input v-model="blockReleaseForm.endDate" type="date" class="block-release-form-input">
                  </div>
                </div>
                <div class="block-release-form-group">
                  <label>Reference <span class="block-release-required">*</span></label>
                  <input v-model="blockReleaseForm.reference" type="text" class="block-release-form-input" placeholder="" required>
                </div>
              </template>
            </div>
          </div>

          <div class="block-release-card-footer">
            <button type="button" class="block-release-btn block-release-btn-primary" @click="onBlockReleaseOk">
              <i class="fas fa-check"></i> ตกลง
            </button>
          </div>
        </div>
      </div>

      <!-- ── Room Cards ── -->
      <div v-else-if="!isLoading" class="room-container">
        <div class="room-grid-wrapper">
          <div v-if="filteredRooms.length" class="room-grid">
             <div v-for="room in filteredRooms" :key="`${activeNavItem}-${room.RmNum || room.RoomNo}`"
              :class="['room-card', getRoomStatusClass(room)]" @dblclick="handleRoomClick(room)">
              <!-- ░░ HEADER ░░ -->
              <div class="room-header">
                <span class="room-number">{{ room.RmNum || room.RoomNo }}</span>

                <!-- status-pill & สีพื้น : แสดงเฉพาะแท็บปกติ -->
                <div v-if="!isArrivalDeparture && room.RmHKStatus" class="status-container">
                  <span class="room-status">
                    {{ getStatusText(room.RmHKStatus) }}
                  </span>
                </div>
              </div>

              <!-- ░░ DETAILS ░░ -->
              <!-- ① Expect Arrival / Departure -->
              <div v-if="isArrivalDeparture" class="arrival-details">
                <div><strong>GstFName:</strong> {{ room.GstFName || '-' }}</div>
                <div><strong>GstNation:</strong> {{ room.GstNation || '-' }}</div>
                <div><strong>GstLevel:</strong> {{ room.GstLevel || '-' }}</div>
              </div>

              <!-- ② แท็บอื่น -->
              <div v-else class="room-details">
                <div class="guest-row">
                  <div class="guest-info">
                    <i class="fa-solid fa-user"></i>
                    {{
                      (
                        room.RmGstName1 ||
                        room.GstFName ||
                        'Vacant'
                      ).toString().slice(0, 20)
                    }}
                  </div>

                  <button v-if="getStatusButtonInfo(room.RmHKStatus).show" class="status-button"
                    :style="{ backgroundColor: getStatusButtonInfo(room.RmHKStatus).color }"
                    @click.stop="updateRoomStatus(room.RmNum, room.RmHKStatus)">
                    {{ getStatusButtonInfo(room.RmHKStatus).label }}
                  </button>
                </div>

                <div v-if="room.RmStatusStrDate" class="date-info">
                  <i class="fa-regular fa-calendar"></i>
                  {{ formatDate(room.RmStatusStrDate) }} –
                  {{ formatDate(room.RmStatusEndDate) }}
                </div>

                <div v-if="room.GstAgent" class="agent-info">
                  <i class="fa-solid fa-building"></i>
                  {{ room.GstAgent }}
                </div>
              </div>
            </div>
          </div>

          <!-- ไม่มีห้องในหมวดนั้น -->
          <div v-else class="no-rooms-message">
            <i class="fa-solid fa-bed"></i>
            <p>ไม่มีห้องพักในหมวดนี้</p>
          </div>
        </div>
      </div>

      <!-- ── Loading ── -->
      <div v-else class="loading-spinner">
        <div class="spinner"></div>
        <span>Loading...</span>
      </div>
    </div>

    <!-- ── Clean Checklist Popup ── -->
    <div v-if="showCleanChecklist" class="clean-checklist-overlay" @click.self="closeCleanChecklist">
      <div class="clean-checklist-modal">
        <div class="clean-checklist-header">
          <h3>
            <i class="fas fa-clipboard-check"></i>
            รายการตรวจห้อง {{ cleanChecklistRoom }}
          </h3>
          <button type="button" class="clean-checklist-close" @click="closeCleanChecklist">&times;</button>
        </div>
        <div class="clean-checklist-body">
          <p class="clean-checklist-hint">กรุณาติ๊กเลือกรายการทั้งหมดก่อนกด OK</p>
          <label
            v-for="item in cleanChecklistItems"
            :key="item.id"
            class="clean-checklist-item"
          >
            <input
              type="checkbox"
              v-model="item.checked"
            />
            <span>{{ item.name }}</span>
          </label>
        </div>
        <div class="clean-checklist-footer">
          <button type="button" class="clean-checklist-btn cancel" @click="closeCleanChecklist">
            ยกเลิก
          </button>
          <button
            type="button"
            class="clean-checklist-btn ok"
            :disabled="!allCleanItemsChecked"
            @click="confirmCleanChecklist"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  </BaseLayout>
</template>

<script>
import { ref, computed, watch, onMounted, getCurrentInstance } from 'vue'
import axios from 'axios'
import Swal from 'sweetalert2'
import BaseLayout from '../../layouts/BaseLayout.vue'
import TopNav from './TopNav.vue'

export default {
  name: 'StatusPage',
  components: { BaseLayout, TopNav },

  setup() {



    const startFloor = ref(Number(localStorage.getItem('roomStartFloor') || 2))
    const endFloor = ref(Number(localStorage.getItem('custTTLFloor') || 6))

    const floors = computed(() => {
      const result = ['all', 'blockRelease']
      for (let i = startFloor.value; i <= endFloor.value; i++) {
        result.push(i.toString())
      }
      return result
    })

    /* แสดง Block/Release ใน Floor Filter เฉพาะเมื่อเลือก Out of Order */
    const floorsFilterOptions = computed(() => {
      if (activeNavItem.value === 'outOfOrder') return floors.value
      return floors.value.filter(f => f !== 'blockRelease')
    })
    /* ─────────────── basic state ─────────────── */
    const { appContext } = getCurrentInstance()
    const api = appContext.config.globalProperties.$api

    const roomData = ref({
      all: [], inHouse: [], clean: [], dirty: [],
      expectArrival: [], expectDeparture: [], outOfOrder: []
    })
    const isLoading = ref(false)
    const selectedFloor = ref('all')
    const activeNavItem = ref('all')

    /* Block / Release (Floor Filter) */
    const blockReleaseTab = ref('block')
    const blockReleaseType = ref('Room') /* 'Room' | 'Floor' ส่งไปตอน submit */
    /* BussDate (sysDate) เป็น yyyy-MM-dd สำหรับ input type="date" */
    const getBussDateYMD = () => {
      const raw = localStorage.getItem('sysDate') || ''
      if (!raw) return new Date().toISOString().slice(0, 10)
      const d = new Date(raw)
      if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10)
      return d.toISOString().slice(0, 10)
    }

    const blockReleaseForm = ref({
      roomNo: '',
      floorNo: '',
      roomStatus: '',
      beginDate: getBussDateYMD(),
      endDate: getBussDateYMD(),
      reference: '',
      buildingNo: ''
    })

    const buildingList = ref([]) /* RmCateCode, RmCateName จาก API getBuildingNo */

    const clearBlockReleaseInputs = () => {
      blockReleaseForm.value.roomNo = ''
      blockReleaseForm.value.floorNo = ''
      blockReleaseForm.value.reference = ''
      blockReleaseForm.value.buildingNo = ''
      blockReleaseForm.value.beginDate = getBussDateYMD()
      blockReleaseForm.value.endDate = getBussDateYMD()
    }

    /* ─────────────── navigation lists ─────────── */
    const topNavItems = [
      { name: 'Status', path: '/housekeeping/status', icon: 'fa-solid fa-bed' },
      { name: 'Minibar', path: '/housekeeping/minibar', icon: 'fa-solid fa-martini-glass' },
      { name: 'Laundry', path: '/housekeeping/laundry', icon: 'fa-solid fa-shirt' },
      { name: 'Damage', path: '/housekeeping/damage', icon: 'fa-solid fa-wrench' },
      { name: 'Lost & Found', path: '/housekeeping/lost-found', icon: 'fa-solid fa-magnifying-glass' },
      { name: 'Maintenance', path: '/housekeeping/maintenance', icon: 'fa-solid fa-screwdriver-wrench' }
    ]

    const navItems = [
      { id: 'all', name: 'Room Status' },
      { id: 'inHouse', name: 'In House' },
      { id: 'clean', name: 'Clean' },
      { id: 'dirty', name: 'Dirty' },
      { id: 'expectArrival', name: 'Expect Arrival' },
      { id: 'expectDeparture', name: 'Expect Departure' },
      { id: 'outOfOrder', name: 'Out of Order' }
    ]

    //const floors = ['all', '2', '3', '4', '5', '6']

    /* ─────────────── computed ─────────────────── */
    const getRoomCount = cat => roomData.value[cat]?.length || 0

    const isArrivalDeparture = computed(() =>
      ['expectArrival', 'expectDeparture'].includes(activeNavItem.value)
    )

    const filteredRooms = computed(() => {
      let rooms = roomData.value[activeNavItem.value] || []
      if (selectedFloor.value !== 'all') {
        const pfx = selectedFloor.value
        rooms = rooms.filter(r =>
          (r.RmNum || r.RoomNo || '').startsWith(pfx)
        )
      }
      return rooms
    })

    /* ─────────────── event handlers ───────────── */
    const handleNavClick = id => (activeNavItem.value = id)

    /* เมื่อออกจาก Out of Order ให้เลิกเลือก Block/Release */
    watch(activeNavItem, (newVal) => {
      if (newVal !== 'outOfOrder' && selectedFloor.value === 'blockRelease') {
        selectedFloor.value = 'all'
      }
    })

    /* เมื่อเปิด Block/Release ให้ตั้ง Begin/End Date เริ่มต้นเป็น BussDate และโหลด Building */
    watch(selectedFloor, (val) => {
      if (val === 'blockRelease' && activeNavItem.value === 'outOfOrder') {
        const buss = getBussDateYMD()
        blockReleaseForm.value.beginDate = buss
        blockReleaseForm.value.endDate = buss
        fetchBuildingNo()
      }
    })

    /* ─────────────── API call ─────────────────── */
    const fetchRoomData = async () => {

      isLoading.value = true
      try {
        const ls = key => localStorage.getItem(key) || ''
        const headers = {
          'Content-Type': 'application/json',
          'db-name': ls('dbName'),
          'hotel-id': ls('hotelID'),
          'com-no': ls('comNo'),
          'login-id': ls('loginID'),
          'sys-date': ls('sysDate'),
          'login-name': ls('loginName')
        }

        const payload = {
          SysDate: ls('sysDate'),
          dbName: ls('dbName'),
          hotelID: ls('hotelID'),
          comNo: ls('comNo'),
          loginid: ls('loginID'),
          loginName: ls('loginName')
        }
        console.log('fetchRoomData sysdate', ls('sysDate'))
        const res = await axios.post(
          `${api}/api/getallpage`,
          payload,
          { headers,  }
        )

        if (res.data?.data) {
          const raw = res.data.data
          roomData.value = {
            all: raw.all || [],
            inHouse: raw.inHouse || [],
            clean: raw.clean || [],
            dirty: raw.dirty || [],
            expectArrival: raw.expectArrival || [],
            expectDeparture: raw.expectDeparture || [],
            outOfOrder: raw.outOfOrder || []
          }
        } else {
          throw new Error('Invalid response format')
        }
      } catch (err) {
        console.error(err)
        Swal.fire({
          title: 'Error!',
          text: err.response?.data?.message || 'ไม่สามารถดึงข้อมูลห้องพักได้',
          icon: 'error'
        })
      } finally {
        isLoading.value = false
      }
    }

    const fetchBuildingNo = async () => {
      try {
        const ls = key => localStorage.getItem(key) || ''
        const headers = {
          'Content-Type': 'application/json',
          'db-name': ls('dbName'),
          'hotel-id': ls('hotelID'),
          'com-no': ls('comNo'),
          'login-id': ls('loginID'),
          'sys-date': ls('sysDate'),
          'login-name': ls('loginName')
        }
        const res = await axios.get(`${api}/api/getBuildingNo`, { headers })
        buildingList.value = res.data?.data || []
      } catch (err) {
        console.error('fetchBuildingNo error:', err)
        buildingList.value = []
      }
    }

    /* ─────────────── utilities ────────────────── */
    const getRoomStatusClass = room => {
      const st = (room.RmHKStatus || '').trim()
      if (!st) return {}
      return {
        occupied: st === 'OC',
        'vacant-clean': st === 'VC',
        'vacant-dirty': st === 'VD',
        'occupied-dirty': st === 'OD',
        'out-of-order': st === 'OOO'
      }
    }

    const formatDate = iso => {
      if (!iso) return ''
      const d = new Date(iso)
      return d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: '2-digit' })
    }

    const handleRoomClick = room => {
      Swal.fire({
        title: `Room: ${room.RmNum || room.RoomNo}`,
        html: `
            <div style="text-align:left">
              <p><strong>GstFName:</strong> ${room.GstFName || room.RmGstName1 || '-'}</p>
              ${room.GstNation ? `<p><strong>GstNation:</strong> ${room.GstNation}</p>` : ''}
              ${room.GstLevel ? `<p><strong>GstLevel:</strong> ${room.GstLevel}</p>` : ''}
            </div>`,
        icon: 'info'
      })
    }

    /* แปลง dd/MM/yyyy หรือ yyyy-MM-dd เป็น yyyy-MM-dd สำหรับส่ง API */
    const toApiDate = (d) => {
      if (!d || !String(d).trim()) return ''
      const parts = String(d).trim().split(/[/-]/)
      if (parts.length !== 3) return d
      if (parts[0].length === 4) return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
      const day = parts[0].padStart(2, '0')
      const month = parts[1].padStart(2, '0')
      const year = parts[2]
      if (year.length === 4 && parseInt(month, 10) <= 12) return `${year}-${month}-${day}`
      return d
    }

    const onBlockReleaseOk = async () => {
      const ls = key => localStorage.getItem(key) || ''
      const headers = {
        'Content-Type': 'application/json',
        'db-name': ls('dbName'),
        'hotel-id': ls('hotelID'),
        'com-no': ls('comNo'),
        'login-id': ls('loginID'),
        'sys-date': ls('sysDate'),
        'login-name': ls('loginName')
      }
      const form = blockReleaseForm.value
      const isBlock = blockReleaseTab.value === 'block'

      if (!form.reference || !String(form.reference).trim()) {
        Swal.fire({ title: 'กรุณากรอก Reference', icon: 'warning' })
        return
      }

      /* Release แบบ Type Room → ใช้ api updateRoomStatus (OOO → VC) */
      if (!isBlock && blockReleaseType.value === 'Room') {
        if (!form.roomNo || !form.roomNo.trim()) {
          Swal.fire({ title: 'กรุณากรอก Room No.', icon: 'warning' })
          return
        }
        const ok = await doUpdateRoomStatus(form.roomNo.trim(), 'OOO', (form.reference || '').trim())
        if (ok) clearBlockReleaseInputs()
        return
      }

      /* Release แบบ Type Floor → ใช้ api updateRoomStatusByFloorRelease */
      if (!isBlock && blockReleaseType.value === 'Floor') {
        if (form.floorNo == null || String(form.floorNo).trim() === '') {
          Swal.fire({ title: 'กรุณากรอก Floor No.', icon: 'warning' })
          return
        }
        try {
          const payload = {
            BussDate: ls('sysDate'),
            FloorNo: parseInt(String(form.floorNo).trim(), 10),
            UserId: ls('loginID'),
            Reference: (form.reference || '').trim()
          }
          const res = await axios.post(`${api}/api/updateRoomStatusByFloorRelease`, payload, { headers })
          const msg = res.data?.message || 'Change Room Status Completed / เปลี่ยนสถานะห้องเสร็จเรียบร้อย.'
          await fetchRoomData()
          Swal.fire({ title: 'สำเร็จ', text: msg, icon: 'success' })
          clearBlockReleaseInputs()
        } catch (err) {
          const msg = err.response?.data?.message || err.response?.data?.error || err.message
          Swal.fire({ title: 'เกิดข้อผิดพลาด', text: msg, icon: 'error' })
        }
        return
      }

      try {
        if (blockReleaseType.value === 'Room') {
          if (!form.roomNo || !form.roomNo.trim()) {
            Swal.fire({ title: 'กรุณากรอก Room No.', icon: 'warning' })
            return
          }
          const payload = {
            RoomNo: form.roomNo.trim(),
            BeginDate: toApiDate(form.beginDate) || undefined,
            EndDate: toApiDate(form.endDate) || undefined,
            Reference: (form.reference || '').trim()
          }
          const res = await axios.post(`${api}/api/updateRoomStatusOOO`, payload, { headers })
          const msg = res.data?.message || 'Change Room Status Completed / เปลี่ยนสถานะห้องเสร็จเรียบร้อย.'
          await fetchRoomData()
          Swal.fire({ title: 'สำเร็จ', text: msg, icon: 'success' })
          clearBlockReleaseInputs()
        } else {
          if (form.floorNo == null || String(form.floorNo).trim() === '') {
            Swal.fire({ title: 'กรุณากรอก Floor No.', icon: 'warning' })
            return
          }
          const payload = {
            FloorNo: parseInt(String(form.floorNo).trim(), 10),
            BeginDate: toApiDate(form.beginDate) || undefined,
            EndDate: toApiDate(form.endDate) || undefined,
            Reference: (form.reference || '').trim(),
            BuildingNo: (form.buildingNo || '').trim()
          }
          const res = await axios.post(`${api}/api/updateRoomStatusByFloor`, payload, { headers })
          const msg = res.data?.message || 'Change Room Status Completed / เปลี่ยนสถานะห้องเสร็จเรียบร้อย.'
          await fetchRoomData()
          Swal.fire({ title: 'สำเร็จ', text: msg, icon: 'success' })
          clearBlockReleaseInputs()
        }
      } catch (err) {
        const msg = err.response?.data?.message || err.response?.data?.error || err.message
        Swal.fire({ title: 'เกิดข้อผิดพลาด', text: msg, icon: 'error' })
      }
    }

    const getNewStatus = old => {
      switch ((old || '').trim()) {
        case 'VC': return 'VD'
        case 'VD': return 'VC'
        case 'OC': return 'OD'
        case 'OD': return 'OC'
        case 'OOO': return 'VD'
        default: return old
      }
    }

    const getStatusButtonInfo = status => {
      const info = { label: '', color: '', show: true }
      if (!status) { info.show = false; return info }

      switch (status.trim()) {
        case 'VC': info.label = 'Dirty'; info.color = '#FFA500'; break
        case 'VD': info.label = 'Clean'; info.color = '#2196F3'; break
        case 'OC': info.label = 'Dirty'; info.color = '#FFA500'; break
        case 'OD': info.label = 'Clean'; info.color = '#2196F3'; break
        case 'OOO': info.label = 'Release'; info.color = '#4CAF50'; break
        default: info.show = false
      }
      return info
    }

    const getStatusText = status => {
      if (!status) return ''
      switch (status.trim()) {
        case 'VC':
        case 'OC': return 'Clean/สะอาด'
        case 'VD':
        case 'OD': return 'Dirty/สกปรก'
        case 'OOO': return 'Out of Order/ปิดห้อง'
        default: return status
      }
    }

    /* ── Clean checklist popup (mock) ── */
    const showCleanChecklist = ref(false)
    const cleanChecklistRoom = ref('')
    const cleanChecklistOldStatus = ref('')
    const cleanChecklistItems = ref([])

    const MOCK_CLEAN_ITEMS = [
      { id: 1, name: 'เตียง / ผ้าปูที่นอน' },
      { id: 2, name: 'ห้องน้ำ / สุขภัณฑ์' },
      { id: 3, name: 'ผ้าเช็ดตัว / อุปกรณ์อาบน้ำ' },
      { id: 4, name: 'มินิบาร์ / สิ่งของในห้อง' },
      { id: 5, name: 'พื้น / ฝุ่น / ขยะ' }
    ]

    const allCleanItemsChecked = computed(() =>
      cleanChecklistItems.value.length > 0 &&
      cleanChecklistItems.value.every(item => item.checked)
    )

    const openCleanChecklist = (roomNum, oldStatus) => {
      cleanChecklistRoom.value = roomNum
      cleanChecklistOldStatus.value = oldStatus
      cleanChecklistItems.value = MOCK_CLEAN_ITEMS.map(item => ({
        ...item,
        checked: false
      }))
      showCleanChecklist.value = true
    }

    const closeCleanChecklist = () => {
      showCleanChecklist.value = false
      cleanChecklistRoom.value = ''
      cleanChecklistOldStatus.value = ''
      cleanChecklistItems.value = []
    }

    const confirmCleanChecklist = async () => {
      if (!allCleanItemsChecked.value) return
      const roomNum = cleanChecklistRoom.value
      const oldStatus = cleanChecklistOldStatus.value
      closeCleanChecklist()
      await doUpdateRoomStatus(roomNum, oldStatus, '')
    }

    const updateRoomStatus = async (roomNum, oldStatus) => {
      const status = (oldStatus || '').trim()
      const isRelease = status === 'OOO'
      const isClean = status === 'VD' || status === 'OD'

      if (isRelease) {
        const { value: refValue, isConfirmed } = await Swal.fire({
          title: 'Release ห้อง ' + roomNum,
          text: 'กรอกเหตุผล Ref',
          input: 'text',
          inputPlaceholder: 'กรอกเหตุผล...',
          showCancelButton: true,
          confirmButtonText: 'ตกลง',
          cancelButtonText: 'ยกเลิก',
          inputValidator: (value) => {
            if (!value || !String(value).trim()) return 'กรุณากรอกเหตุผล'
            return null
          }
        })
        if (!isConfirmed) return
        await doUpdateRoomStatus(roomNum, oldStatus, refValue ? String(refValue).trim() : '')
        return
      }

      if (isClean) {
        openCleanChecklist(roomNum, oldStatus)
        return
      }

      await doUpdateRoomStatus(roomNum, oldStatus, '')
    }

    const doUpdateRoomStatus = async (roomNum, oldStatus, refValue) => {
      try {
        const ls = key => localStorage.getItem(key) || ''
        const headers = {
          'Content-Type': 'application/json',
          'db-name': ls('dbName'),
          'hotel-id': ls('hotelID'),
          'com-no': ls('comNo'),
          'login-id': ls('loginID'),
          'sys-date': ls('sysDate'),
          'login-name': ls('loginName')
        }

        const payload = {
          BussDate: ls('sysDate'),
          RoomNo: roomNum,
          NewStatus: getNewStatus(oldStatus),
          OldStatus: oldStatus,
          CleanId: ls('loginID'),
          CleanId2: '',
          UserId: ls('loginID'),
          Ref: refValue
        }

        const res = await axios.post(
          `${api}/api/updateRoomStatus`,
          payload,
          { headers }
        )

        if (res.status === 200) {
          await fetchRoomData()
          Swal.fire({ title: 'Success!', text: 'Room status updated', icon: 'success', timer: 1500 })
          return true
        }
        throw new Error('Failed to update room status')
      } catch (err) {
        console.error(err)
        Swal.fire({ title: 'Error!', text: 'Failed to update room status', icon: 'error' })
        return false
      }
    }

    /* ─────────────── lifecycle ──────────────── */
    onMounted(fetchRoomData)
    /* ─────────────── expose to template ─────── */
    return {
      /* state & nav */
      topNavItems, navItems, floors, floorsFilterOptions,
      roomData, isLoading, selectedFloor, activeNavItem,
      blockReleaseTab, blockReleaseType, blockReleaseForm, buildingList,

      /* computed / helpers */
      getRoomCount, isArrivalDeparture, filteredRooms,
      handleNavClick, getRoomStatusClass, formatDate,
      getStatusButtonInfo, getStatusText, updateRoomStatus,
      handleRoomClick, onBlockReleaseOk,
      showCleanChecklist, cleanChecklistRoom, cleanChecklistItems,
      allCleanItemsChecked, closeCleanChecklist, confirmCleanChecklist
    }
  }
}
</script>

<style scoped>
.top-nav {
  margin-top: 60px;
  background-color: #fefefe;
  padding: 0;
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: space-around;
  position: fixed;
  top: 0;
  left: 300px;
  right: 0;
  z-index: 1000;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  transition: left 0.3s ease-in-out;
}

#sidebar:not(.active)~#content .top-nav {
  left: 0;
}

.top-nav-item {
  color: #333;
  text-decoration: none;
  padding: 0 20px;
  height: 100%;
  display: flex;
  align-items: center;
  font-size: 14px;
  transition: all 0.2s ease;
  gap: 8px;
  position: relative;
}

.top-nav-item:hover {
  color: #2196f3;
}

.top-nav-item.router-link-active {
  color: #2196f3;
  font-weight: 500;
}

.top-nav-item.router-link-active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 3px;
  background-color: #2196f3;
  transition: all 0.2s ease;
}

.content-container {
  margin-top: 100px;
  height: calc(100vh - 140px);
  display: flex;
  flex-direction: column;
  background-color: #f5f5f5;
  overflow: hidden;
}

.main-nav {
  background-color: #ffffff;
  padding: 0;
  height: 40px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  border-bottom: 1px solid #e0e0e0;
}

.nav-links {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 16px;
}

.nav-item {
  color: rgba(0, 0, 0, 0.7);
  text-decoration: none;
  padding: 0 20px;
  height: 100%;
  display: flex;
  align-items: center;
  font-size: 14px;
  transition: all 0.2s ease;
  position: relative;
  border-bottom: 2px solid transparent;
}

.nav-item::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 2px;
  background-color: transparent;
  transition: all 0.2s ease;
}

.nav-item:hover::after {
  background-color: #2f0fff;
}

.nav-item.active {
  color: #2f0fff;
  font-weight: 500;
}

.nav-item.active::after {
  background-color: #2f0fff;
}

.floor-filter {
  background: #ffffff;
  padding: 8px 16px;
  display: flex;
  gap: 8px;
  border-bottom: 1px solid #e0e0e0;
  flex-shrink: 0;
}

.floor-btn {
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: #666;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 14px;
  position: relative;
}

.floor-btn:hover {
  color: #2f0fff;
}

.floor-btn.active {
  color: #2f0fff;
  font-weight: 500;
}

/* Block / Release panel – ธีมแบบ CustomerNameComponent, กึ่งกลาง + ขยาย 50% */
.block-release-panel {
  flex: 1;
  padding: 18px;
  background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
  overflow: auto;
  display: flex;
  justify-content: center;
  align-items: center;
}

.block-release-config-card {
  background: white;
  border-radius: 12px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  width: 100%;
  max-width: 960px; /* ขยายจาก 640 → 960 (+50%) */
}

.block-release-card-header {
  background: linear-gradient(60deg, #29323c 0%, #485563 100%);
  color: white;
  padding: 18px 27px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.block-release-card-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 9px;
}

.block-release-tabs {
  display: flex;
  gap: 0;
}

.block-release-tab {
  padding: 9px 24px;
  border: none;
  background: rgba(255, 255, 255, 0.15);
  color: white;
  font-size: 18px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.block-release-tab:hover {
  background: rgba(255, 255, 255, 0.25);
}

.block-release-tab.active {
  background: white;
  color: #29323c;
}

.block-release-card-content {
  padding: 22px 27px;
}

.block-release-form-section {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.block-release-form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px;
}

.block-release-form-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.block-release-required {
  color: #dc2626;
}

.block-release-form-section label {
  font-weight: 600;
  color: #374151;
  font-size: 16px;
}

.block-release-form-input,
.block-release-form-select {
  padding: 9px 15px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 18px;
  transition: all 0.2s ease;
  background: white;
}

.block-release-form-input:focus,
.block-release-form-select:focus {
  outline: none;
  border-color: #29323c;
  box-shadow: 0 0 0 1px rgba(41, 50, 60, 0.15);
}

.block-release-form-select {
  cursor: pointer;
}

.block-release-card-footer {
  background: #f8fafc;
  padding: 18px 27px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.block-release-btn {
  padding: 9px 18px;
  border: none;
  border-radius: 6px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 6px;
}

.block-release-btn-primary {
  background: linear-gradient(60deg, #29323c 0%, #485563 100%);
  color: white;
}

.block-release-btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(41, 50, 60, 0.4);
}

.floor-btn.active::after {
  content: '';
  position: absolute;
  bottom: -9px;
  left: 0;
  width: 100%;
  height: 2px;
  background-color: #2f0fff;
}

.room-container {
  flex: 1;
  position: relative;
  overflow: hidden;
  /* padding: 10px; */
  margin-left: 20px;
  margin-right: 20px;
}

.room-grid-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  overflow-y: auto;
  padding: 10px;
}

.room-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
}

.room-card {
  border-radius: 8px;
  padding: 15px;
  background: white;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  transition: transform 0.2s;
}

.room-card:hover {
  transform: translateY(-2px);
}

.room-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
  align-items: flex-start;
}

.status-container {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.room-number {
  font-size: 18px;
  font-weight: bold;
}

.room-status {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.1);
}

.room-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.guest-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.guest-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  flex: 1;
}

.date-info,
.agent-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

i {
  width: 16px;
}

.loading-spinner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #f0f0f0;
  border-top: 3px solid #000080;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}

/* Room status colors */
.occupied {
  background: linear-gradient(135deg, #ffd1ff 0%, #fae3ff 100%);
}

.vacant-clean {
  background: linear-gradient(135deg, #a8e6cf 0%, #dcedc1 100%);
}

.vacant-dirty {
  background: linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%);
}

.occupied-dirty {
  background: linear-gradient(135deg, #e2e2e2 0%, #d7d7d7 100%);
}

.out-of-order {
  background: linear-gradient(135deg, #ff6b6b 0%, #ffb3b3 100%);
}

.room-count {
  margin-left: 4px;
  font-size: 12px;
  color: #666;
}

.nav-item.active .room-count {
  color: #2f0fff;
}

.status-button {
  padding: 4px 12px;
  border: none;
  border-radius: 4px;
  color: white;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 11px;
}

.status-button:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

.status-button:active {
  transform: translateY(0);
}

/* Tablet */
@media (max-width: 1024px) {
  .top-nav {
    left: 0;
  }

  .content-container {
    margin-top: 110px;
  }

  .main-nav {
    height: auto;
    min-height: 40px;
  }

  .nav-links {
    overflow-x: auto;
    padding: 0 12px;
  }

  .nav-item {
    padding: 0 14px;
    font-size: 13px;
    white-space: nowrap;
  }

  .floor-filter {
    padding: 8px 12px;
    overflow-x: auto;
  }

  .floor-btn {
    padding: 6px 14px;
    font-size: 13px;
    white-space: nowrap;
  }

  .room-grid {
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
  }

  .room-card {
    padding: 12px;
  }

  .room-number {
    font-size: 16px;
  }

  .guest-info,
  .date-info,
  .agent-info {
    font-size: 13px;
  }
}

/* Mobile */
@media (max-width: 768px) {
  .top-nav {
    left: 0;
    margin-top: 70px;
  }

  .content-container {
    margin-top: 120px;
    height: calc(100vh - 130px);
  }

  .main-nav {
    height: auto;
    padding: 4px 0;
  }

  .nav-links {
    display: flex;
    overflow-x: auto;
    padding: 0 8px;
    gap: 8px;
    -webkit-overflow-scrolling: touch;
  }

  .nav-item {
    padding: 0 10px;
    font-size: 12px;
    white-space: nowrap;
    min-width: fit-content;
  }

  .room-count {
    font-size: 11px;
  }

  .floor-filter {
    padding: 8px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .floor-btn {
    padding: 6px 12px;
    font-size: 12px;
    flex-shrink: 0;
  }

  .room-container {
    margin-left: 8px;
    margin-right: 8px;
  }

  .room-grid-wrapper {
    padding: 8px;
  }

  .room-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 12px;
  }

  .room-card {
    padding: 12px;
    border-radius: 8px;
  }

  .room-header {
    margin-bottom: 8px;
  }

  .room-number {
    font-size: 16px;
  }

  .room-status {
    font-size: 11px;
    padding: 3px 6px;
  }

  .guest-info {
    font-size: 12px;
    gap: 6px;
  }

  .guest-info i {
    font-size: 11px;
  }

  .date-info,
  .agent-info {
    font-size: 11px;
    gap: 6px;
  }

  .date-info i,
  .agent-info i {
    font-size: 10px;
    width: 14px;
  }

  .status-button {
    padding: 4px 10px;
    font-size: 10px;
  }

  .arrival-details {
    font-size: 12px;
  }

  .arrival-details div {
    margin-bottom: 6px;
  }

  .loading-spinner {
    font-size: 14px;
  }

  .spinner {
    width: 32px;
    height: 32px;
  }

  .no-rooms-message i {
    font-size: 36px;
  }

  .no-rooms-message p {
    font-size: 14px;
  }
}

/* Small Mobile */
@media (max-width: 480px) {
  .content-container {
    margin-top: 110px;
  }

  .nav-item {
    padding: 0 8px;
    font-size: 11px;
  }

  .floor-btn {
    padding: 5px 10px;
    font-size: 11px;
  }

  .room-grid {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .room-card {
    padding: 10px;
  }

  .room-number {
    font-size: 15px;
  }

  .room-status {
    font-size: 10px;
  }

  .guest-info,
  .date-info,
  .agent-info {
    font-size: 11px;
  }

  .status-button {
    padding: 3px 8px;
    font-size: 9px;
  }
}

.no-rooms-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
  gap: 12px;
}

.no-rooms-message i {
  font-size: 48px;
  opacity: 0.5;
}

.no-rooms-message p {
  font-size: 16px;
  margin: 0;
}

/* Clean checklist popup */
.clean-checklist-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  padding: 16px;
}

.clean-checklist-modal {
  background: #fff;
  border-radius: 10px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.clean-checklist-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #eee;
  background: #f8f9fb;
}

.clean-checklist-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #222;
  display: flex;
  align-items: center;
  gap: 8px;
}

.clean-checklist-header h3 i {
  color: #2196F3;
}

.clean-checklist-close {
  border: none;
  background: transparent;
  font-size: 24px;
  line-height: 1;
  color: #888;
  cursor: pointer;
  padding: 0 4px;
}

.clean-checklist-close:hover {
  color: #333;
}

.clean-checklist-body {
  padding: 16px 20px 8px;
}

.clean-checklist-hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: #666;
}

.clean-checklist-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  color: #333;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.clean-checklist-item:hover {
  background: #f5f9ff;
  border-color: #c5d9f5;
}

.clean-checklist-item input[type="checkbox"] {
  width: 18px;
  height: 18px;
  accent-color: #2196F3;
  cursor: pointer;
  flex-shrink: 0;
}

.clean-checklist-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px 18px;
  border-top: 1px solid #eee;
}

.clean-checklist-btn {
  min-width: 88px;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s ease, background 0.15s ease;
}

.clean-checklist-btn.cancel {
  background: #f0f0f0;
  color: #444;
}

.clean-checklist-btn.cancel:hover {
  background: #e4e4e4;
}

.clean-checklist-btn.ok {
  background: #2196F3;
  color: #fff;
}

.clean-checklist-btn.ok:hover:not(:disabled) {
  background: #1976D2;
}

.clean-checklist-btn.ok:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>