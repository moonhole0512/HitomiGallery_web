document.addEventListener('DOMContentLoaded', () => {
    // Main gallery elements
    const galleryContainer = document.getElementById('gallery-container');
    const pageInfo = document.getElementById('page-info');
    const prevButton = document.getElementById('prev-page');
    const nextButton = document.getElementById('next-page');
    const searchButton = document.getElementById('search-button');
    const updateButton = document.getElementById('update-button');
    const recommendButton = document.getElementById('recommend-button');

    // Modal elements
    const modal = document.getElementById('cover-modal');
    const modalCloseBtn = document.querySelector('.modal-close');
    const modalImageContainer = document.getElementById('modal-image-container');
    const modalConfirmBtn = document.getElementById('modal-confirm-button');

    // Info Modal elements
    const infoModal = document.getElementById('info-modal');
    const infoModalContent = document.getElementById('info-modal-content');
    const infoModalCloseBtn = infoModal.querySelector('.modal-close');


    const searchInputs = {
        title: document.getElementById('title-search'),
        person: document.getElementById('person-search'),
        series: document.getElementById('series-search'),
        characters: document.getElementById('characters-search'),
        tags: document.getElementById('tags-search'),
        rate: document.getElementById('rate-select'),
        pageSize: document.getElementById('page-size-select'),
        thumbSize: document.getElementById('thumb-size-select'),
        sort: document.getElementById('sort-select'),
        uncensoredOnly: document.getElementById('uncensored-only'),
    };

    let currentPage = 1;
    let currentSeed = null;
    let currentCoverChange = { id: null, path: null };

    const updateThumbSize = () => {
        const size = searchInputs.thumbSize.value;
        galleryContainer.classList.remove('small', 'medium', 'large');
        galleryContainer.classList.add(size);
        localStorage.setItem('thumbSize', size);
    };

    searchInputs.thumbSize.addEventListener('change', updateThumbSize);

    // Load thumb size from localStorage
    const savedThumbSize = localStorage.getItem('thumbSize') || 'small';
    searchInputs.thumbSize.value = savedThumbSize;
    updateThumbSize();

    const saveSearchState = () => {
        const state = {
            currentPage,
            currentSeed,
            searchParams: {
                title: searchInputs.title.value,
                person: searchInputs.person.value,
                series: searchInputs.series.value,
                characters: searchInputs.characters.value,
                tags: searchInputs.tags.value,
                rate: searchInputs.rate.value,
                pageSize: searchInputs.pageSize.value,
                thumbSize: searchInputs.thumbSize.value,
                sort: searchInputs.sort.value,
                uncensoredOnly: searchInputs.uncensoredOnly.checked,
            }
        };
        sessionStorage.setItem('galleryState', JSON.stringify(state));
    };

    const fetchGalleries = async () => {
        let query = `page=${currentPage}`;

        // Handle random seed persistence
        const sortValue = searchInputs.sort.value;
        if (sortValue === 'RANDOM') {
            if (currentSeed === null) {
                currentSeed = Math.random();
            }
            query += `&seed=${currentSeed}`;
        } else {
            currentSeed = null; // Clear seed if not in random mode
        }

        for (const key in searchInputs) {
            const input = searchInputs[key];
            if (input.type === 'checkbox') {
                if (input.checked) {
                    const apiKey = key === 'uncensoredOnly' ? 'uncensored_only' : key;
                    query += `&${apiKey}=true`;
                }
            } else if (input.value && input.value.trim() !== '') {
                // Special handling for page size to use 'page_size' as the query parameter name
                if (key === 'pageSize') {
                    query += `&page_size=${encodeURIComponent(input.value.trim())}`;
                } else {
                    query += `&${key}=${encodeURIComponent(input.value.trim())}`;
                }
            }
        }
        console.log('Search triggered with:', query);
        try {
            const response = await fetch(`/api/galleries?${query}`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            renderGalleries(data.galleries);
            renderPagination(data.currentPage, data.totalPages);
            saveSearchState();
        } catch (error) {
            console.error('Failed to fetch galleries:', error);
            galleryContainer.innerHTML = '<p class="error">Failed to load galleries. Is the server running?</p>';
        }
    };

    const renderGalleries = (galleries) => {
        galleryContainer.innerHTML = '';
        if (!galleries || galleries.length === 0) {
            galleryContainer.innerHTML = '<p>No results found.</p>';
            return;
        }

        galleries.forEach(gallery => {
            const item = document.createElement('div');
            item.className = 'gallery-item';
            item.id = `gallery-item-${gallery.id_hitomi}`;

            const link = document.createElement('a');
            link.href = `/reader/${gallery.id_hitomi}`;
            link.href = `/reader/${gallery.id_hitomi}`;

            const img = document.createElement('img');
            img.src = `/cover/${gallery.id_hitomi}.jpg?t=${new Date().getTime()}`;
            img.alt = gallery.title;
            img.onerror = () => { img.src = '/static/noImage.jpg'; };
            link.appendChild(img);

            const title = document.createElement('div');
            title.className = 'title';
            title.textContent = gallery.title || 'No Title';
            title.title = gallery.title || 'No Title';
            link.appendChild(title);

            item.appendChild(link);

            // Uncensored / Decensored Badge
            const isUncensored = (gallery.title && (gallery.title.toLowerCase().includes('decensored') || gallery.title.toLowerCase().includes('uncensored'))) ||
                                 (gallery.tags && gallery.tags.toLowerCase().includes('uncensored'));
            
            if (isUncensored) {
                const badge = document.createElement('div');
                badge.className = 'uncensored-badge';
                badge.textContent = 'UNCENSORED';
                item.appendChild(badge);
            }

            // 액션 바 생성
            const actionBar = document.createElement('div');
            actionBar.className = 'action-bar';

            const infoBtn = document.createElement('button');
            infoBtn.className = 'action-btn info-btn';
            infoBtn.innerHTML = 'i';
            infoBtn.title = 'Show Info';
            infoBtn.onclick = (e) => {
                e.stopPropagation(); e.preventDefault();
                openInfoModal(gallery);
            };
            actionBar.appendChild(infoBtn);

            const changeCoverBtn = document.createElement('button');
            changeCoverBtn.className = 'action-btn change-cover-btn';
            changeCoverBtn.innerHTML = '&#128444;';
            changeCoverBtn.title = 'Change Cover';
            changeCoverBtn.onclick = (e) => {
                e.stopPropagation(); e.preventDefault();
                openCoverModal(gallery.id_hitomi);
            };
            actionBar.appendChild(changeCoverBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'action-btn delete-btn';
            deleteBtn.innerHTML = '&times;';
            deleteBtn.title = 'Delete';
            deleteBtn.onclick = (e) => {
                e.stopPropagation(); e.preventDefault();
                if (confirm(`Are you sure you want to delete "${gallery.title}"?`)) {
                    deleteItem(gallery.id_hitomi);
                }
            };
            actionBar.appendChild(deleteBtn);

            item.appendChild(actionBar);

            const ratingContainer = document.createElement('div');
            ratingContainer.className = 'rating-container';
            ratingContainer.classList.add(gallery.rate > 0 ? 'has-rating' : 'no-rating');

            for (let i = 1; i <= 5; i++) {
                const star = document.createElement('div');
                star.className = 'rating-star';
                if (i <= gallery.rate) star.classList.add('rated');
                star.dataset.rate = i;
                star.onclick = (e) => {
                    e.stopPropagation(); e.preventDefault();
                    const oldRate = gallery.rate;
                    const newRate = oldRate === parseInt(star.dataset.rate) ? 0 : parseInt(star.dataset.rate);
                    gallery.rate = newRate; // Update local object state
                    setRating(gallery.id_hitomi, newRate, oldRate);
                };
                ratingContainer.appendChild(star);
            }
            item.appendChild(ratingContainer);

            galleryContainer.appendChild(item);
        });
    };

    const renderPagination = (page, totalPages) => {
        currentPage = page;
        pageInfo.textContent = `Page ${page} of ${totalPages}`;
        prevButton.disabled = page <= 1;
        nextButton.disabled = page >= totalPages;
    };

    const setRating = async (id, newRate, oldRate) => {
        const item = document.getElementById(`gallery-item-${id}`);
        const ratingContainer = item.querySelector('.rating-container');
        const stars = item.querySelectorAll('.rating-star');
        stars.forEach(star => star.classList.toggle('rated', star.dataset.rate <= newRate));
        if (oldRate === 0 && newRate > 0) {
            ratingContainer.classList.replace('no-rating', 'has-rating');
        } else if (oldRate > 0 && newRate === 0) {
            ratingContainer.classList.replace('has-rating', 'no-rating');
        }

        try {
            const response = await fetch(`/api/galleries/${id}/rate`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rate: newRate })
            });
            if (!response.ok) throw new Error('Failed to update rating on server.');
        } catch (error) {
            console.error('Error setting rating:', error);
            alert('Failed to save rating. Reverting UI changes.');
            stars.forEach(star => star.classList.toggle('rated', star.dataset.rate <= oldRate));
            if (oldRate === 0 && newRate > 0) {
                ratingContainer.classList.replace('has-rating', 'no-rating');
            } else if (oldRate > 0 && newRate === 0) {
                ratingContainer.classList.replace('no-rating', 'has-rating');
            }
        }
    };

    const deleteItem = async (id) => {
        try {
            const response = await fetch(`/api/galleries/${id}`, { method: 'DELETE' });
            if (!response.ok) throw new Error('Failed to delete item.');
            const item = document.getElementById(`gallery-item-${id}`);
            item.style.transition = 'opacity 0.5s';
            item.style.opacity = '0';
            setTimeout(() => item.remove(), 500);
        } catch (error) {
            console.error('Error deleting item:', error);
            alert('Failed to delete item.');
        }
    };

    const openCoverModal = async (id) => {
        console.log(`Opening cover modal for ID: ${id}`);
        currentCoverChange.id = id;
        modalImageContainer.innerHTML = '<p>Loading images...</p>';
        modal.classList.replace('modal-hidden', 'modal-visible');

        try {
            const response = await fetch(`/api/galleries/${id}/images`);
            console.log('Cover images API response:', response);
            if (!response.ok) {
                throw new Error(`Could not load image list. Server responded with status: ${response.status}`);
            }
            const data = await response.json();
            console.log('Parsed cover images data:', data);

            modalImageContainer.innerHTML = '';
            const imagesToShow = data.images.slice(0, 5);
            console.log(`Showing ${imagesToShow.length} of ${data.images.length} images.`);

            imagesToShow.forEach(imagePath => {
                const thumb = document.createElement('img');
                thumb.src = `/api/galleries/${id}/image?path=${encodeURIComponent(imagePath)}`;
                thumb.dataset.path = imagePath;
                thumb.onclick = () => {
                    const currentlySelected = modalImageContainer.querySelector('.selected');
                    if (currentlySelected) currentlySelected.classList.remove('selected');
                    thumb.classList.add('selected');
                    currentCoverChange.path = imagePath;
                    console.log(`Selected new cover path: ${imagePath}`);
                };
                modalImageContainer.appendChild(thumb);
            });
        } catch (error) {
            console.error('Error in openCoverModal:', error);
            modalImageContainer.innerHTML = `<p class='error'>${error.message}</p>`;
        }
    };

    const setCover = async () => {
        if (!currentCoverChange.id || !currentCoverChange.path) {
            alert('Please select an image first.');
            return;
        }

        try {
            const response = await fetch(`/api/galleries/${currentCoverChange.id}/cover`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: currentCoverChange.path })
            });
            if (!response.ok) throw new Error('Failed to update cover.');

            // Refresh the image on the main page
            const galleryImg = document.querySelector(`#gallery-item-${currentCoverChange.id} img`);
            // Add a cache-busting query parameter
            galleryImg.src = `/cover/${currentCoverChange.id}.jpg?t=${new Date().getTime()}`;

            closeModal();
        } catch (error) {
            console.error('Error setting cover:', error);
            alert(error.message);
        }
    };

    const openInfoModal = (gallery) => {
        infoModalContent.innerHTML = `
            <p><strong>Title:</strong> ${gallery.title || 'N/A'}</p>
            <p><strong>Artist:</strong> ${gallery.person || 'N/A'}</p>
            <p><strong>Series:</strong> ${gallery.series || 'N/A'}</p>
            <p><strong>Characters:</strong> ${gallery.characters || 'N/A'}</p>
            <p><strong>Tags:</strong> ${gallery.tags || 'N/A'}</p>
        `;
        infoModal.classList.replace('modal-hidden', 'modal-visible');
    };

    const closeInfoModal = () => {
        infoModal.classList.replace('modal-visible', 'modal-hidden');
    };


    const closeModal = () => {
        modal.classList.replace('modal-visible', 'modal-hidden');
        currentCoverChange = { id: null, path: null };
    };

    // Event Listeners
    updateButton.addEventListener('click', async () => {
        updateButton.textContent = 'Updating...';
        updateButton.disabled = true;
        try {
            const response = await fetch('/api/update', { method: 'POST' });
            if (!response.ok) throw new Error('Failed to start update.');
            alert('Database update started in the background. This may take a while.');
        } catch (error) {
            console.error('Error starting update:', error);
            alert(error.message);
        } finally {
            setTimeout(() => {
                updateButton.textContent = 'Update DB';
                updateButton.disabled = false;
            }, 10000); // Re-enable after 10s
        }
    });

    recommendButton.addEventListener('click', async () => {
        galleryContainer.innerHTML = '<p>Analysing your taste and finding best matches...</p>';
        recommendButton.disabled = true;
        try {
            const isUncensoredOnly = searchInputs.uncensoredOnly.checked;
            const query = `limit=40${isUncensoredOnly ? '&uncensored_only=true' : ''}`;
            const response = await fetch(`/api/recommend?${query}`);
            if (!response.ok) throw new Error('Failed to fetch recommendations.');
            const data = await response.json();
            
            if (data.message) {
                alert(data.message);
                fetchGalleries(); // Fallback to normal search
                return;
            }

            renderGalleries(data.galleries);
            pageInfo.textContent = 'Personalized Recommendations';
            prevButton.disabled = true;
            nextButton.disabled = true;
        } catch (error) {
            console.error('Recommendation error:', error);
            alert('Failed to get recommendations.');
        } finally {
            recommendButton.disabled = false;
        }
    });

    prevButton.addEventListener('click', () => { if (currentPage > 1) { currentPage--; fetchGalleries(); } });
    nextButton.addEventListener('click', () => { currentPage++; fetchGalleries(); });
    searchButton.addEventListener('click', () => { currentPage = 1; currentSeed = null; fetchGalleries(); });
    Object.values(searchInputs).forEach(input => {
        if (input.type === 'checkbox') {
            input.addEventListener('change', () => { currentPage = 1; currentSeed = null; fetchGalleries(); });
        } else if (input.tagName === 'INPUT') {
            input.addEventListener('keyup', (event) => {
                if (event.key === 'Enter') { currentPage = 1; currentSeed = null; fetchGalleries(); }
            });
        } else if (input.tagName === 'SELECT') {
            input.addEventListener('change', () => { currentPage = 1; currentSeed = null; fetchGalleries(); });
        }
    });

    modalCloseBtn.addEventListener('click', closeModal);
    modalConfirmBtn.addEventListener('click', setCover);
    infoModalCloseBtn.addEventListener('click', closeInfoModal);

    window.addEventListener('click', (event) => {
        if (event.target == modal) closeModal();
        if (event.target == infoModal) closeInfoModal();
    });

    // Initial load from sessionStorage
    const savedStateStr = sessionStorage.getItem('galleryState');
    if (savedStateStr) {
        try {
            const state = JSON.parse(savedStateStr);
            currentPage = state.currentPage || 1;
            currentSeed = state.currentSeed || null;

            if (state.searchParams) {
                for (const key in state.searchParams) {
                    if (searchInputs[key]) {
                        if (searchInputs[key].type === 'checkbox') {
                            searchInputs[key].checked = state.searchParams[key];
                        } else {
                            searchInputs[key].value = state.searchParams[key];
                        }
                    }
                }
                updateThumbSize();
            }
        } catch (e) {
            console.error('Failed to parse saved state:', e);
        }
    }

    fetchGalleries();

    // Autocomplete Logic
    const autocompleteFields = [
        { id: 'person-search', fieldName: 'person' },
        { id: 'series-search', fieldName: 'series' },
        { id: 'characters-search', fieldName: 'characters' },
    ];

    const createAutocompleteDropdown = (inputElement) => {
        // Create a wrapper div for the input and its dropdown
        const wrapper = document.createElement('div');
        wrapper.style.position = 'relative'; // Make wrapper a positioning context
        wrapper.style.display = 'inline-block'; // To not break flex layout of search-row
        wrapper.style.width = inputElement.offsetWidth + 'px'; // Match input width

        // Insert wrapper before the input
        inputElement.parentNode.insertBefore(wrapper, inputElement);
        // Move input into the wrapper
        wrapper.appendChild(inputElement);

        let dropdown = document.createElement('ul');
        dropdown.className = 'autocomplete-dropdown';
        dropdown.style.position = 'absolute';
        dropdown.style.top = inputElement.offsetHeight + 'px'; // Position below the input
        dropdown.style.left = '0'; // Align with the left edge of the input
        dropdown.style.zIndex = '1000';
        dropdown.style.backgroundColor = '#333';
        dropdown.style.border = '1px solid #555';
        dropdown.style.maxHeight = '200px';
        dropdown.style.overflowY = 'auto';
        dropdown.style.listStyle = 'none';
        dropdown.style.padding = '0';
        dropdown.style.margin = '0';
        dropdown.style.width = '100%'; // Take full width of the wrapper
        dropdown.style.display = 'none'; // Hidden by default

        wrapper.appendChild(dropdown); // Append dropdown to the wrapper
        return dropdown;
    };

    const debounce = (func, delay) => {
        let timeout;
        return function (...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), delay);
        };
    };

    autocompleteFields.forEach(fieldConfig => {
        const input = document.getElementById(fieldConfig.id);
        if (!input) return;

        const dropdown = createAutocompleteDropdown(input);
        let selectedIndex = -1;

        const fetchSuggestions = async () => {
            const query = input.value.trim();
            if (query.length < 2) {
                dropdown.innerHTML = '';
                dropdown.style.display = 'none';
                selectedIndex = -1;
                return;
            }
            try {
                const response = await fetch(`/api/autocomplete?field=${fieldConfig.fieldName}&query=${encodeURIComponent(query)}`);
                if (!response.ok) throw new Error('Failed to fetch suggestions.');
                const data = await response.json();
                renderSuggestions(data.suggestions);
            } catch (error) {
                console.error('Autocomplete error:', error);
                dropdown.innerHTML = '';
                dropdown.style.display = 'none';
            }
        };

        const renderSuggestions = (suggestions) => {
            dropdown.innerHTML = '';
            if (suggestions.length === 0) {
                dropdown.style.display = 'none';
                return;
            }
            suggestions.forEach((suggestion, index) => {
                const li = document.createElement('li');
                li.textContent = suggestion;
                li.style.padding = '8px';
                li.style.cursor = 'pointer';
                li.style.color = 'white';
                li.onmouseover = () => {
                    if (selectedIndex !== -1) {
                        dropdown.children[selectedIndex].style.backgroundColor = '';
                    }
                    li.style.backgroundColor = '#555';
                    selectedIndex = index;
                };
                li.onclick = () => {
                    input.value = suggestion;
                    dropdown.innerHTML = '';
                    dropdown.style.display = 'none';
                    selectedIndex = -1;
                    console.log('Autocomplete selected:', suggestion);
                    fetchGalleries(); // Trigger search on selection
                };
                dropdown.appendChild(li);
            });
            dropdown.style.display = 'block';
            selectedIndex = -1; // Reset selected index
        };

        const debouncedFetchSuggestions = debounce(fetchSuggestions, 300);

        input.addEventListener('input', debouncedFetchSuggestions);

        input.addEventListener('keydown', (e) => {
            const items = dropdown.children;
            if (items.length === 0) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (selectedIndex < items.length - 1) {
                    if (selectedIndex !== -1) items[selectedIndex].style.backgroundColor = '';
                    selectedIndex++;
                    items[selectedIndex].style.backgroundColor = '#555';
                    items[selectedIndex].scrollIntoView(false);
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (selectedIndex > 0) {
                    if (selectedIndex !== -1) items[selectedIndex].style.backgroundColor = '';
                    selectedIndex--;
                    items[selectedIndex].style.backgroundColor = '#555';
                    items[selectedIndex].scrollIntoView(false);
                }
            } else if (e.key === 'Enter') {
                if (selectedIndex > -1) {
                    e.preventDefault();
                    items[selectedIndex].click();
                }
            }
        });

        input.addEventListener('focus', () => {
            if (dropdown.children.length > 0 && input.value.trim().length >= 2) {
                dropdown.style.display = 'block';
            }
        });

        input.addEventListener('blur', () => {
            // Delay hiding to allow click event on suggestion to fire
            setTimeout(() => {
                dropdown.style.display = 'none';
                selectedIndex = -1;
            }, 100);
        });
    });
});
