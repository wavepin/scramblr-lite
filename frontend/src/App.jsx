import { BrowserRouter, Routes, Route } from 'react-router-dom'               
  import { QueueProvider } from './QueueContext'                                
  import Header from './assets/Header'
  import Landing from './pages/Landing'                                         
  import Login from './pages/Login'
  import ResetPassword from './pages/ResetPassword'
  import Playback from './pages/Playback'                                       
  import Home from './pages/Home'
  import Survey from './pages/Survey'                                           
  import Activity from './pages/Activity'
  import Playlist from './pages/Playlist'
                                                                                
  function App() {
      return (                                                                  
          <BrowserRouter>
              <QueueProvider>
                  <Routes>
                      <Route path='/' element={<Landing />} />                             
                      <Route path='/login' element={<Login />} />
                              
                      <Route path='/reset-password' element={<> <Header /> <main
   style={{ paddingTop: '80px'}}> <ResetPassword /> </main> </>} />             
                      <Route path='/playback' element={<Playback />} />
                      <Route path='/playlist' element={<Playlist />} />
                      <Route path='/playlist/:playlistId' element={<Playlist />} />            
                      <Route path='/home' element={<Home />} />
                      <Route path='/survey' element={<Survey />} />                     
                      <Route path='/activity' element={<Activity />} />                   
                  </Routes>
              </QueueProvider>                                                  
          </BrowserRouter>
      )
  }

  export default App
